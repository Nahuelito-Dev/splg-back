import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RouteBatch } from '../../order/entities/route-batch.entity';
import { errorMessage } from '../../common/errors/error-message';
import { RouteStopRemovedReason } from '../../order/entities/route-batch-stop.entity';
import { RouteBatchKind, RouteBatchStatus } from '../domain/route-batch.enums';
import {
  hojaTerminada,
  partirRecorrido,
} from '../domain/route-sheet-execution';
import { assertTransition } from '../domain/route-sheet.machine';
import { RouteSheetEtaService } from './route-sheet-eta.service';
import {
  QuienOpera,
  RouteSheetInProgress,
} from './route-sheet-in-progress.service';
import { RouteSheetLocks } from './route-sheet-locks.service';
import { RouteSheetNotifier } from './route-sheet-notifier.service';
import { RouteSheetProgress } from './route-sheet-progress.service';
import { RouteSheetWriter } from './route-sheet-writer.service';
import { hojaNoEnCurso, hojaNoEncontrada } from './route-sheet.exceptions';

export interface ResultadoDeCierre {
  sheetId: string;
  /** Ya estaba cerrada (reintento): no se hizo nada. */
  alreadyClosed: boolean;
  /** Paradas que quedaban pendientes: salieron de la hoja y se reprogramaron. */
  releasedOrderIds: string[];
  /** La fecha nueva de cada una (`null`: no se pudo reprogramar y espera al admin). */
  rescheduled: Array<{ orderId: string; scheduledDate: string | null }>;
}

/**
 * Cierre de la hoja en curso (§5, `assigned → completed`):
 *  - solo, cuando no le queda nada por hacer (todo entregado o fuera de la
 *    hoja): lo dispara el aviso de cada entrega y lo repasa el seguimiento;
 *  - a mano (chofer o admin) con motivo: las paradas pendientes salen
 *    (`sheet_closed`), sus pedidos se le liberan al chofer y se reprograman
 *    solos para el día hábil siguiente (no vuelven al despacho común).
 * Las paradas que quedan se apagan sin motivo, como al completar un lote de M4.
 */
@Injectable()
export class RouteSheetCloseService {
  private readonly logger = new Logger(RouteSheetCloseService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly locks: RouteSheetLocks,
    private readonly progress: RouteSheetProgress,
    private readonly writer: RouteSheetWriter,
    private readonly eta: RouteSheetEtaService,
    private readonly notifier: RouteSheetNotifier,
    private readonly hoja: RouteSheetInProgress,
  ) {}

  /** Cierre a mano con motivo (las pendientes vuelven al despacho). Idempotente. */
  async cerrar(
    distributorId: string,
    id: string,
    quien: QuienOpera,
    motivo: string,
  ): Promise<ResultadoDeCierre> {
    if (quien.esChofer) {
      await this.hoja.choferDeLaHoja(distributorId, id, quien.userId);
    }
    return this.locks.conCerrojo([id], async () => {
      const actual = await this.dataSource.manager.findOne(RouteBatch, {
        where: { batchId: id, distributorId, kind: RouteBatchKind.PLANNED },
      });
      if (!actual) throw hojaNoEncontrada();
      if (actual.status === RouteBatchStatus.COMPLETED) {
        return {
          sheetId: id,
          alreadyClosed: true,
          releasedOrderIds: [],
          rescheduled: [],
        };
      }
      if (actual.status !== RouteBatchStatus.ASSIGNED) throw hojaNoEnCurso();
      const paradas = await this.progress.paradas(
        this.dataSource.manager,
        actual,
        false,
      );
      const r = partirRecorrido(
        paradas.map((p) => ({ orderId: p.stop.orderId, progress: p.progress })),
      );
      const liberados: string[] = [];
      const reprogramados: ResultadoDeCierre['rescheduled'] = [];
      for (const orderId of [
        ...(r.enCamino ? [r.enCamino] : []),
        ...r.pendientes,
      ]) {
        try {
          await this.hoja.sacarYLiberar(actual, orderId, quien, {
            motivo: RouteStopRemovedReason.SHEET_CLOSED,
            nota: motivo.slice(0, 300),
          });
          liberados.push(orderId);
          reprogramados.push({
            orderId,
            scheduledDate: await this.hoja.reprogramar(actual, orderId),
          });
        } catch (error) {
          // Se entregó o se canceló justo ahora: queda como esté.
          this.logger.warn(
            `Hoja ${id}: la parada ${orderId} no se liberó al cerrar: ${errorMessage(error)}`,
          );
        }
      }
      await this.completar(distributorId, id, motivo.slice(0, 300));
      await this.despues(distributorId, id, 'manual', liberados);
      return {
        sheetId: id,
        alreadyClosed: false,
        releasedOrderIds: liberados,
        rescheduled: reprogramados,
      };
    });
  }

  /**
   * Cierra la hoja si ya no le queda nada por hacer. Con el cerrojo de la hoja y
   * mirando las paradas con la fila tomada (una parada agregada en el medio la
   * mantiene abierta). Devuelve si la cerró.
   */
  async completarSiTermino(
    distributorId: string,
    id: string,
  ): Promise<boolean> {
    try {
      const cerro = await this.locks.conCerrojo([id], () =>
        this.locks.enTransaccion(distributorId, [{ id }], async (m, [fila]) => {
          if (fila.status !== RouteBatchStatus.ASSIGNED) return false;
          const paradas = await this.progress.paradas(m, fila);
          const r = partirRecorrido(
            paradas.map((p) => ({
              orderId: p.stop.orderId,
              progress: p.progress,
            })),
          );
          if (!hojaTerminada(r)) return false;
          await this.cerrarFila(m, fila, null);
          return true;
        }),
      );
      if (cerro) await this.despues(distributorId, id, 'finished', []);
      return cerro;
    } catch (error) {
      this.logger.warn(
        `Hoja ${id}: no se pudo cerrar sola: ${errorMessage(error)}`,
      );
      return false;
    }
  }

  private completar(
    distributorId: string,
    id: string,
    nota: string | null,
  ): Promise<void> {
    return this.locks.enTransaccion(distributorId, [{ id }], (m, [fila]) =>
      fila.status === RouteBatchStatus.ASSIGNED
        ? this.cerrarFila(m, fila, nota)
        : Promise.resolve(),
    );
  }

  private async cerrarFila(
    m: EntityManager,
    fila: RouteBatch,
    nota: string | null,
  ): Promise<void> {
    assertTransition(fila.kind, fila.status, RouteBatchStatus.COMPLETED);
    await this.writer.apagarTodas(m, fila.batchId, null);
    fila.status = RouteBatchStatus.COMPLETED;
    fila.closedAt = new Date();
    fila.closeNote = nota;
    await m.save(fila);
  }

  private async despues(
    distributorId: string,
    id: string,
    como: 'manual' | 'finished',
    liberados: string[],
  ): Promise<void> {
    const [fila]: Array<{ userId: string | null }> =
      await this.dataSource.query(
        `SELECT d."user_id" AS "userId" FROM "route_batch" b
           LEFT JOIN "delivery" d ON d."delivery_id" = b."delivery_id"
          WHERE b."batch_id" = $1`,
        [id],
      );
    const userId = fila?.userId ?? null;
    await this.eta.olvidarChofer(userId);
    if (userId) {
      this.notifier.alChofer(userId, 'route-sheet:closed', {
        sheetId: id,
        reason: como,
        releasedOrderIds: liberados,
      });
    }
    this.notifier.alPanel(distributorId, 'route-sheet:closed', {
      sheetId: id,
      reason: como,
      releasedOrderIds: liberados,
    });
  }
}
