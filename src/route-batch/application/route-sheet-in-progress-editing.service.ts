import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RoleType } from '../../common/constants/role-type.enum';
import { errorMessage } from '../../common/errors/error-message';
import { OrderStatus } from '../../order/entities/order.entity';
import { RouteStopRemovedReason } from '../../order/entities/route-batch-stop.entity';
import { OrderService } from '../../order/order.service';
import { motivoNoPlanificable } from '../domain/route-sheet-rules';
import { RouteSheetDataService } from './route-sheet-data.service';
import { RouteSheetInProgress } from './route-sheet-in-progress.service';
import { RouteSheetLocks } from './route-sheet-locks.service';
import {
  CalculoEnCurso,
  RouteSheetProgress,
} from './route-sheet-progress.service';
import { RouteSheetWriter } from './route-sheet-writer.service';
import {
  paradaNoPendiente,
  pedidoNoEncontrado,
  pedidoNoPlanificable,
  pedidoYaAgrupado,
} from './route-sheet.exceptions';

/**
 * El admin cambia la hoja en curso (§6.5, D-05): agrega una parada (se le
 * asigna al chofer y entra en la mejor posición de la cola) o saca una
 * pendiente (el pedido se libera y vuelve al despacho). Al chofer sólo se le
 * avisa. Con la versión optimista de la hoja, como la edición del borrador.
 */
@Injectable()
export class RouteSheetInProgressEditingService {
  private readonly logger = new Logger(RouteSheetInProgressEditingService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly locks: RouteSheetLocks,
    private readonly progress: RouteSheetProgress,
    private readonly writer: RouteSheetWriter,
    private readonly data: RouteSheetDataService,
    private readonly orders: OrderService,
    private readonly hoja: RouteSheetInProgress,
  ) {}

  /**
   * El admin agrega un pedido a la hoja en curso: se le asigna al chofer y entra
   * en la mejor posición de la cola (o en `position`, 1 = la próxima después
   * de la que está en camino). Al chofer sólo se le avisa (D-05).
   */
  async agregarEnCurso(
    distributorId: string,
    id: string,
    body: { version: number; orderId: string; position?: number },
    actorUserId: string,
  ): Promise<void> {
    await this.locks.conCerrojo([id], async () => {
      const sheet = await this.hoja.enCurso(distributorId, id, body.version);
      const [p] = await this.data.pedidos(distributorId, [body.orderId]);
      if (!p) throw pedidoNoEncontrado();
      if (p.activeBatchId) throw pedidoYaAgrupado();
      const motivo = motivoNoPlanificable(p, sheet.planDate as string);
      if (motivo) throw pedidoNoPlanificable(motivo);
      await this.orders.assignDelivery(
        body.orderId,
        sheet.deliveryId as string,
        distributorId,
        { soloSiLibre: true },
      );
      const chofer = await this.hoja.choferDe(sheet);
      let calculo: CalculoEnCurso;
      try {
        calculo = await this.locks.enTransaccion(
          distributorId,
          [{ id, version: body.version }],
          async (manager, [fila]) => {
            await this.writer.activarParada(
              manager,
              fila.batchId,
              body.orderId,
              false,
            );
            fila.editedAt = new Date();
            await manager.save(fila);
            return this.progress.rehacer(manager, fila, {
              reordenar: false,
              nowMs: Date.now(),
              posicion: chofer
                ? await this.progress.posicionDelChofer(
                    chofer.userId,
                    Date.now(),
                  )
                : null,
              insertar: { orderId: body.orderId, en: body.position },
            });
          },
        );
      } catch (error) {
        // La parada no entró: el pedido no queda asignado a un chofer sin hoja.
        await this.orders
          .updateStatus(
            body.orderId,
            OrderStatus.PENDING,
            undefined,
            RoleType.ADMIN,
            actorUserId,
          )
          .catch((e: unknown) =>
            this.logger.error(
              `Hoja ${id}: el pedido ${body.orderId} quedó asignado sin parada: ${errorMessage(e)}`,
            ),
          );
        throw error;
      }
      await this.hoja.trasCambio(distributorId, id, calculo, chofer);
      if (chofer) {
        this.hoja.avisarCambio(chofer, id, 'stop_added', {
          orderId: body.orderId,
        });
      }
    });
  }

  /** El admin saca una parada pendiente de la hoja en curso: el pedido se libera y vuelve al despacho. */
  async quitarEnCurso(
    distributorId: string,
    id: string,
    orderId: string,
    version: number,
    actorUserId: string,
  ): Promise<void> {
    await this.locks.conCerrojo([id], async () => {
      const sheet = await this.hoja.enCurso(distributorId, id, version);
      const paradas = await this.progress.paradas(
        this.dataSource.manager,
        sheet,
        false,
      );
      const parada = this.hoja.parada(paradas, orderId);
      if (parada.progress !== 'pending') throw paradaNoPendiente();
      await this.hoja.sacarYLiberar(
        sheet,
        orderId,
        { userId: actorUserId, esChofer: false },
        { motivo: RouteStopRemovedReason.ADMIN, nota: null },
        true,
      );
      const chofer = await this.hoja.choferDe(sheet);
      await this.hoja.rehacer(distributorId, id, chofer?.userId ?? null, {
        reordenar: true,
      });
      if (chofer)
        this.hoja.avisarCambio(chofer, id, 'stop_removed', { orderId });
    });
  }
}
