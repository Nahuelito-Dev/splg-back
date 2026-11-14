import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RoleType } from '../../common/constants/role-type.enum';
import { idCortoDePedido } from '../../common/events/aviso-al-admin';
import { OrderStatus } from '../../order/entities/order.entity';
import {
  RouteBatchStop,
  RouteStopRemovedReason,
} from '../../order/entities/route-batch-stop.entity';
import { OrderService } from '../../order/order.service';
import {
  ResultadoDelIntento,
  partirRecorrido,
  resultadoDelIntento,
  siguienteParada,
} from '../domain/route-sheet-execution';
import {
  QuienOpera,
  RouteSheetInProgress,
} from './route-sheet-in-progress.service';
import { RouteSheetLocks } from './route-sheet-locks.service';
import {
  FranjaEstimada,
  RouteSheetNotifier,
  horaArgentina,
} from './route-sheet-notifier.service';
import { RouteSheetProgress } from './route-sheet-progress.service';
import {
  otraParadaEnCamino,
  paradaNoEncontrada,
  paradaNoPendiente,
} from './route-sheet.exceptions';

const isoDe = (ms: number): string => new Date(ms).toISOString();

/** Por qué no se entregó (lo elige el chofer en la app). */
export enum FailedDeliveryReason {
  CUSTOMER_ABSENT = 'customer_absent',
  REJECTED = 'rejected',
  WRONG_ADDRESS = 'wrong_address',
  NO_ACCESS = 'no_access',
  OTHER = 'other',
}

export const ETIQUETA_NO_ENTREGA: Record<FailedDeliveryReason, string> = {
  [FailedDeliveryReason.CUSTOMER_ABSENT]: 'El cliente no estaba',
  [FailedDeliveryReason.REJECTED]: 'El cliente rechazó el pedido',
  [FailedDeliveryReason.WRONG_ADDRESS]: 'La dirección no es correcta',
  [FailedDeliveryReason.NO_ACCESS]: 'No se pudo llegar al domicilio',
  [FailedDeliveryReason.OTHER]: 'Otro motivo',
};

export interface ResultadoDeParada {
  sheetId: string;
  orderId: string;
  /** La próxima parada que la app le propone al chofer. */
  nextOrderId: string | null;
  /** El chofer marcó una parada que no era la siguiente: la cola se reordenó. */
  detour?: boolean;
  /** «No pude entregar»: qué intento fue (1 o 2). */
  attempt?: 1 | 2;
  /**
   * `requeued`: la parada volvió al final de la cola del chofer (primer
   * intento). `rescheduled`: salió de la hoja y el pedido se reprogramó solo
   * para el día hábil siguiente (segundo intento).
   */
  outcome?: ResultadoDelIntento;
  /** Segundo intento: la fecha nueva del pedido (`null` si no se pudo reprogramar: espera al admin). */
  rescheduledTo?: string | null;
  /** Primer intento: la franja estimada nueva («más tarde»), o `null` si no tiene hora estimada. */
  newWindowStart?: string | null;
  newWindowEnd?: string | null;
}

/**
 * La hoja en curso, parada por parada (§8.1, §6.5): «en camino» (una sola a la
 * vez; si no es la siguiente, es un desvío y se reordena la cola), «Llegué»
 * (la v2 con control de distancia) y «No pude entregar» con motivo: en el primer
 * intento la parada vuelve al final de la cola del mismo chofer; en el segundo
 * sale de la hoja y el pedido se reprograma solo para el día hábil siguiente.
 * Ningún pedido vuelve al despacho común (rediseño del 14/11).
 * La entrega en sí la confirma el cliente con el QR, por el
 * endpoint del pedido; la hoja la sigue sola (ver `RouteSheetWatchService`).
 *
 * Todo con el cerrojo de la hoja; las transiciones del pedido pasan por los
 * casos de uso de siempre.
 */
@Injectable()
export class RouteSheetStopsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly locks: RouteSheetLocks,
    private readonly progress: RouteSheetProgress,
    private readonly orders: OrderService,
    private readonly notifier: RouteSheetNotifier,
    private readonly hoja: RouteSheetInProgress,
  ) {}

  /** El chofer sale hacia una parada. */
  async enCamino(
    distributorId: string,
    id: string,
    orderId: string,
    userId: string,
  ): Promise<ResultadoDeParada> {
    const chofer = await this.hoja.choferDeLaHoja(distributorId, id, userId);
    return this.locks.conCerrojo([id], async () => {
      const sheet = await this.hoja.enCurso(distributorId, id);
      const paradas = await this.progress.paradas(
        this.dataSource.manager,
        sheet,
        false,
      );
      const parada = this.hoja.parada(paradas, orderId);
      const recorrido = partirRecorrido(
        paradas.map((p) => ({ orderId: p.stop.orderId, progress: p.progress })),
      );
      if (parada.progress === 'on_the_way') {
        return { sheetId: id, orderId, nextOrderId: orderId, detour: false };
      }
      if (parada.progress !== 'pending') throw paradaNoPendiente();
      if (
        recorrido.enCamino ||
        (await this.hoja.otroEnCaminoDelChofer(chofer.deliveryId, orderId))
      ) {
        throw otraParadaEnCamino();
      }
      const desvio = siguienteParada(recorrido) !== orderId;
      await this.orders.updateStatus(
        orderId,
        OrderStatus.ON_THE_WAY,
        userId,
        RoleType.DELIVERY,
        userId,
      );
      await this.hoja.rehacer(distributorId, id, chofer.userId, {
        reordenar: desvio,
      });
      this.notifier.alPanel(distributorId, 'route-sheet:stop-progress', {
        sheetId: id,
        orderId,
        progress: 'on_the_way',
        detour: desvio,
      });
      if (desvio) this.hoja.avisarCambio(chofer, id, 'reordered', { orderId });
      return { sheetId: id, orderId, nextOrderId: orderId, detour: desvio };
    });
  }

  /** «Llegué»: la v2 del pedido (radio de llegada), y queda anotado en la parada. */
  async llegue(
    distributorId: string,
    id: string,
    orderId: string,
    userId: string,
    pos: { latitude: number; longitude: number },
  ): Promise<{ message: string; arrivedAt: string }> {
    await this.hoja.choferDeLaHoja(distributorId, id, userId);
    const sheet = await this.hoja.enCurso(distributorId, id);
    const stop = await this.dataSource.manager.findOne(RouteBatchStop, {
      where: { batchId: sheet.batchId, orderId, active: true },
    });
    if (!stop) throw paradaNoEncontrada();
    const r = await this.orders.notifyDriverArrivedWithDistance(
      orderId,
      userId,
      RoleType.DELIVERY,
      pos.latitude,
      pos.longitude,
    );
    const arrivedAt = stop.arrivedAt ?? new Date();
    if (!stop.arrivedAt) {
      await this.dataSource.manager.update(
        RouteBatchStop,
        { stopId: stop.stopId },
        { arrivedAt },
      );
      this.notifier.alPanel(distributorId, 'route-sheet:stop-progress', {
        sheetId: id,
        orderId,
        progress: 'arrived',
        arrivedAt: arrivedAt.toISOString(),
      });
    }
    return { message: r.message, arrivedAt: arrivedAt.toISOString() };
  }

  /**
   * «No pude entregar» (chofer, o admin en su nombre): se avisa al cliente por
   * push y al admin (panel y bandeja).
   *  - Primer intento: el pedido sigue siendo del chofer (si estaba en camino
   *    vuelve a aceptado) y la parada pasa al FINAL de la cola («el 3 pasa a ser
   *    el 10»); la cola se reordena y se recalcula la hora de TODO lo pendiente
   *    desde la posición actual. Al cliente de este pedido y al admin se les
   *    avisa «se reprogramó para más tarde» con la franja nueva; a los demás
   *    cuya hora se corrió, el aviso de corrimiento de siempre. El reintento ya
   *    no conserva la franja comprada.
   *  - Segundo intento (la parada ya era un reintento): sale de la hoja
   *    (`rescheduled`), el pedido se le libera al chofer y el sistema lo
   *    reprograma solo para el primer día hábil con la planificación abierta,
   *    sin franja fija (la hora la calcula el planificador de ese día). El
   *    admin puede cambiarle la fecha o cancelarlo después, pero no tiene que
   *    hacer nada.
   */
  async noEntregada(
    distributorId: string,
    id: string,
    orderId: string,
    quien: QuienOpera,
    motivo: { reason: FailedDeliveryReason; note?: string },
  ): Promise<ResultadoDeParada> {
    const chofer = quien.esChofer
      ? await this.hoja.choferDeLaHoja(distributorId, id, quien.userId)
      : null;
    return this.locks.conCerrojo([id], async () => {
      const sheet = await this.hoja.enCurso(distributorId, id);
      const paradas = await this.progress.paradas(
        this.dataSource.manager,
        sheet,
        false,
      );
      const parada = this.hoja.parada(paradas, orderId);
      if (parada.progress !== 'pending' && parada.progress !== 'on_the_way') {
        throw paradaNoPendiente();
      }
      const nota = [ETIQUETA_NO_ENTREGA[motivo.reason], motivo.note?.trim()]
        .filter((x) => !!x)
        .join(': ')
        .slice(0, 300);
      const outcome = resultadoDelIntento(parada.stop.failedAttempts);
      const attempt: 1 | 2 = outcome === 'requeued' ? 1 : 2;
      const ahora = new Date();
      let rescheduledTo: string | null | undefined;
      if (outcome === 'requeued') {
        if (parada.progress === 'on_the_way') {
          await this.orders.postergarEntrega(
            orderId,
            sheet.deliveryId as string,
          );
        }
        await this.dataSource.manager.update(
          RouteBatchStop,
          { stopId: parada.stop.stopId },
          {
            failedAttempts: 1,
            lastFailedAt: ahora,
            lastFailureNote: nota,
            arrivedAt: null,
            waitAlertedAt: null,
          },
        );
      } else {
        await this.hoja.sacarYLiberar(sheet, orderId, quien, {
          motivo: RouteStopRemovedReason.RESCHEDULED,
          nota,
        });
        await this.dataSource.manager.update(
          RouteBatchStop,
          { stopId: parada.stop.stopId },
          { failedAttempts: 2, lastFailedAt: ahora, lastFailureNote: nota },
        );
        rescheduledTo = await this.hoja.reprogramar(sheet, orderId);
      }
      const delChofer = chofer ?? (await this.hoja.choferDe(sheet));
      // Se reordena y se recalcula TODO lo pendiente desde la posición actual;
      // en el primer intento, al cliente de este pedido se le avisa la franja
      // nueva («más tarde») y a los demás, el corrimiento de siempre.
      const calculo = await this.hoja.rehacer(
        distributorId,
        id,
        delChofer?.userId ?? null,
        {
          reordenar: true,
          ...(outcome === 'requeued' ? { postergado: orderId } : {}),
        },
      );
      const franja = calculo?.postergado ?? null;
      await this.avisarIntento(
        distributorId,
        id,
        orderId,
        attempt,
        nota,
        franja,
      );
      if (delChofer && !quien.esChofer) {
        this.hoja.avisarCambio(delChofer, id, 'stop_failed', {
          orderId,
          attempt,
          outcome,
          nextOrderId: calculo ? siguienteParada(calculo.recorrido) : null,
        });
      }
      return {
        sheetId: id,
        orderId,
        nextOrderId: calculo ? siguienteParada(calculo.recorrido) : null,
        attempt,
        outcome,
        ...(outcome === 'rescheduled' ? { rescheduledTo } : {}),
        ...(outcome === 'requeued'
          ? {
              newWindowStart: franja ? isoDe(franja.windowStartMs) : null,
              newWindowEnd: franja ? isoDe(franja.windowEndMs) : null,
            }
          : {}),
      };
    });
  }

  /**
   * El intento fallido: cliente, panel y bandeja del admin. En el primero, con
   * la franja estimada nueva («se reprogramó para más tarde»; el push al
   * cliente ya salió con el recálculo). Sin hora estimada (sin punto o sin
   * origen), el aviso de siempre, sin franja.
   */
  private async avisarIntento(
    distributorId: string,
    id: string,
    orderId: string,
    attempt: 1 | 2,
    nota: string,
    franja: FranjaEstimada | null,
  ): Promise<void> {
    // El segundo intento le avisa al cliente la reprogramación (con la fecha).
    if (attempt === 1 && !franja) {
      const [p]: Array<{ customerId: string }> = await this.dataSource.query(
        `SELECT "customer_id" AS "customerId" FROM "order" WHERE "order_id" = $1`,
        [orderId],
      );
      if (p) {
        await this.notifier.noEntregadoAlCliente(
          p.customerId,
          orderId,
          attempt,
        );
      }
    }
    this.notifier.alPanel(distributorId, 'route-sheet:stop-failed', {
      sheetId: id,
      orderId,
      attempt,
      outcome: attempt === 1 ? 'requeued' : 'rescheduled',
      note: nota,
      ...(attempt === 1
        ? {
            windowStart: franja ? isoDe(franja.windowStartMs) : null,
            windowEnd: franja ? isoDe(franja.windowEndMs) : null,
          }
        : {}),
    });
    // El segundo intento lo avisa la reprogramación (informativo en la bandeja).
    if (attempt !== 1) return;
    const horario = franja
      ? ` Nueva hora estimada: entre las ${horaArgentina(franja.windowStartMs)} y las ${horaArgentina(franja.windowEndMs)}.`
      : '';
    this.notifier.aLaBandeja(distributorId, {
      kind: 'route_sheet_stop_requeued',
      title: 'Pedido reprogramado para más tarde',
      body: `El pedido ${idCortoDePedido(orderId)} no se pudo entregar (${nota}). Pasó al final del recorrido del chofer.${horario}`,
      dedupeKey: `route-sheet-stop-requeued:${id}:${orderId}`,
    });
  }
}
