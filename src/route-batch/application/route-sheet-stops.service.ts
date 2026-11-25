import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RoleType } from '../../common/constants/role-type.enum';
import { conCodigo } from '../../common/errors/con-codigo';
import { errorMessage } from '../../common/errors/error-message';
import {
  FailedVisitOutcome,
  FailedVisitReason,
} from '../../failed-visit/domain/nueva-visita';
import { FailedVisitNotifier } from '../../failed-visit/failed-visit.notifier';
import {
  FailedVisitService,
  ResultadoDeVisita,
  VisitaFallida,
  motivoLegible,
} from '../../failed-visit/failed-visit.service';
import { idCortoDePedido } from '../../common/events/aviso-al-admin';
import { ReleaseOrderUseCase } from '../../order/application/release-order.use-case';
import { OrderItem } from '../../order/entities/order-item.entity';
import { Order, OrderStatus } from '../../order/entities/order.entity';
import { RouteBatch } from '../../order/entities/route-batch.entity';
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
import { RouteBatchStatus } from '../domain/route-batch.enums';
import {
  PlanDeReprogramacion,
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
  ROUTE_SHEET_EXECUTION_CODES,
  hojaNoEnCurso,
  otraParadaEnCamino,
  paradaNoEncontrada,
  paradaNoPendiente,
} from './route-sheet.exceptions';

const isoDe = (ms: number): string => new Date(ms).toISOString();

/** La visita no se asentó (el pedido cambió de manos en el medio): no se escribe nada. */
function visitaNoAsentada(): ConflictException {
  return conCodigo(
    ConflictException,
    409,
    'El pedido cambió mientras se informaba la entrega fallida: actualizá y probá de nuevo',
    ROUTE_SHEET_EXECUTION_CODES.STOP_NOT_PENDING,
  );
}

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
  /** «No pude entregar»: la visita fallida asentada (C5) y en qué quedó la nueva visita del pedido. */
  visita?: ResultadoDeVisita;
}

/** El resultado tal como lo devuelven los endpoints de la hoja: sin el registro interno de la visita. */
export function resultadoParaLaHoja(
  r: ResultadoDeParada,
): Omit<ResultadoDeParada, 'visita'> {
  const copia = { ...r };
  delete copia.visita;
  return copia;
}

/** Lo que suma el «No pude entregar» unificado (C5): ubicación y acuerdo con el cliente. */
export type DatosDeVisita = Pick<
  VisitaFallida,
  'reason' | 'latitude' | 'longitude' | 'accuracyMeters' | 'agreed'
>;

/** El motivo de la hoja en el vocabulario de las visitas fallidas (C5). */
const MOTIVO_DE_VISITA: Record<FailedDeliveryReason, FailedVisitReason> = {
  [FailedDeliveryReason.CUSTOMER_ABSENT]: FailedVisitReason.CUSTOMER_ABSENT,
  [FailedDeliveryReason.REJECTED]: FailedVisitReason.REJECTED,
  [FailedDeliveryReason.NO_ACCESS]: FailedVisitReason.ADDRESS_CLOSED,
  [FailedDeliveryReason.WRONG_ADDRESS]: FailedVisitReason.OTHER,
  [FailedDeliveryReason.OTHER]: FailedVisitReason.OTHER,
};

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
  private readonly logger = new Logger(RouteSheetStopsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly locks: RouteSheetLocks,
    private readonly progress: RouteSheetProgress,
    private readonly orders: OrderService,
    private readonly notifier: RouteSheetNotifier,
    private readonly hoja: RouteSheetInProgress,
    private readonly visitas: FailedVisitService,
    private readonly avisosDeVisita: FailedVisitNotifier,
    private readonly release: ReleaseOrderUseCase,
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
   *    y queda propuesto al cliente con una franja con cupo (C5): puede aceptar
   *    o elegir otro día. Si con esta visita el pedido llega al tope de visitas
   *    fallidas, no se reprograma: espera la decisión del admin.
   * Cada intento queda en el historial de visitas del pedido (`visita`), con la
   * ubicación si la mandó el chofer.
   */
  async noEntregada(
    distributorId: string,
    id: string,
    orderId: string,
    quien: QuienOpera,
    motivo: { reason: FailedDeliveryReason; note?: string },
    datos?: DatosDeVisita,
  ): Promise<ResultadoDeParada & { visita: ResultadoDeVisita }> {
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
      const visita = this.visitaDeHoja(quien, motivo, datos);
      // Lo que sólo se lee (el día al que se reprogramaría) va antes de la
      // transacción.
      const plan =
        outcome === 'rescheduled'
          ? await this.hoja.planDeReprogramacion(sheet, orderId)
          : null;
      // Todo el intento en una sola transacción (C5): la parada, el pedido (por
      // la máquina de estados) y la visita fallida con su contador. Si algo
      // falla no queda nada a medias (la parada sigue en la hoja y el pedido
      // como estaba) y el error sube. Los avisos, después del commit.
      const hecho = await this.locks.enTransaccion(
        distributorId,
        [{ id }],
        async (manager, [fila]) => {
          if (fila.status !== RouteBatchStatus.ASSIGNED) throw hojaNoEnCurso();
          if (outcome === 'requeued') {
            const postergado =
              parada.progress === 'on_the_way'
                ? await this.orders.postergarEntregaEn(
                    manager,
                    orderId,
                    sheet.deliveryId as string,
                  )
                : null;
            await manager.update(
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
            const r = await this.visitas.registrarDeHoja(
              {
                ...visita,
                orderId,
                salida: 'requeued',
                rescheduledTo: null,
                deliveryId: sheet.deliveryId,
              },
              ahora,
              manager,
            );
            if (!r) throw visitaNoAsentada();
            return {
              visita: r,
              postergado,
              liberado: null,
              alAdmin: false,
              vigente: null,
            };
          }
          // Si el día acordado con el cliente no vale, corta acá (400/409) y
          // no se escribe nada. `alAdmin`: con esta visita el pedido llega al
          // tope y no se reprograma solo.
          const { alAdmin } = await this.visitas.prepararDeHoja(
            orderId,
            outcome,
            datos?.agreed,
            ahora,
            manager,
          );
          const liberado = await this.sacarYLiberarEn(manager, sheet, {
            stopId: parada.stop.stopId,
            orderId,
            motivo: alAdmin
              ? RouteStopRemovedReason.NEEDS_RESCHEDULE
              : RouteStopRemovedReason.RESCHEDULED,
            nota,
            ahora,
          });
          // El plan se revalida acá, con la planificación de esos días
          // bloqueada: si mientras tanto se cerró, vale el siguiente día.
          const vigente =
            !alAdmin && plan
              ? await this.hoja.aplicarReprogramacion(
                  manager,
                  sheet,
                  orderId,
                  plan,
                )
              : plan;
          const r = await this.visitas.registrarDeHoja(
            {
              ...visita,
              orderId,
              salida: 'rescheduled',
              rescheduledTo: alAdmin ? null : (vigente?.fecha ?? null),
              dias: alAdmin ? [] : (vigente?.dias ?? []),
              deliveryId: sheet.deliveryId,
            },
            ahora,
            manager,
          );
          if (!r) throw visitaNoAsentada();
          // Sin día con cupo en el horizonte: la parada espera al admin.
          if (r.outcome === FailedVisitOutcome.AWAITING_ADMIN) {
            await manager.update(
              RouteBatchStop,
              { stopId: parada.stop.stopId },
              { removedReason: RouteStopRemovedReason.NEEDS_RESCHEDULE },
            );
          }
          return { visita: r, postergado: null, liberado, alAdmin, vigente };
        },
      );
      const rescheduledTo =
        outcome === 'rescheduled' ? hecho.visita.scheduledDate : undefined;
      await this.avisarSalida(
        sheet,
        orderId,
        outcome,
        visita,
        hecho,
        hecho.vigente,
      );
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
        visita: hecho.visita,
      };
    });
  }

  /**
   * Segundo intento, dentro de la transacción: la parada sale de la hoja (con
   * el motivo y la nota) y el pedido vuelve a pendiente sin chofer por el
   * camino único de liberación (máquina de estados). Tiene que seguir siendo
   * del chofer de la hoja.
   */
  private async sacarYLiberarEn(
    manager: EntityManager,
    sheet: RouteBatch,
    s: {
      stopId: string;
      orderId: string;
      motivo: RouteStopRemovedReason;
      nota: string;
      ahora: Date;
    },
  ): Promise<{ pedido: Order; choferAnterior: string | null }> {
    await manager.update(
      RouteBatchStop,
      { stopId: s.stopId },
      {
        active: false,
        removedReason: s.motivo,
        removedAt: s.ahora,
        removedNote: s.nota,
        failedAttempts: 2,
        lastFailedAt: s.ahora,
        lastFailureNote: s.nota,
      },
    );
    const locked = await manager
      .createQueryBuilder(Order, 'ord')
      .setLock('pessimistic_write', undefined, ['ord'])
      .leftJoinAndSelect('ord.delivery', 'delivery')
      .where('ord.orderId = :id', { id: s.orderId })
      .getOne();
    if (!locked) throw new NotFoundException('Pedido no encontrado');
    if (!sheet.deliveryId || locked.deliveryId !== sheet.deliveryId) {
      throw new ConflictException(
        'El pedido ya no es del chofer de esta hoja de ruta',
      );
    }
    locked.items = await manager.find(OrderItem, {
      where: { orderId: s.orderId },
    });
    const choferAnterior = await this.release.releaseWithin(manager, locked);
    const pedido = await manager.save(locked);
    return { pedido, choferAnterior };
  }

  /**
   * Lo que va a la visita fallida (C5): el motivo en su vocabulario, la nota,
   * la ubicación y el acuerdo si los mandó el chofer, y quién la informó.
   */
  private visitaDeHoja(
    quien: QuienOpera,
    motivo: { reason: FailedDeliveryReason; note?: string },
    datos?: DatosDeVisita,
  ): VisitaFallida {
    const d = datos ?? { reason: MOTIVO_DE_VISITA[motivo.reason] };
    // Un motivo de la hoja sin equivalente («dirección incorrecta») va como «otro» con su texto.
    const nota =
      d.reason === FailedVisitReason.OTHER &&
      motivo.reason !== FailedDeliveryReason.OTHER
        ? [ETIQUETA_NO_ENTREGA[motivo.reason], motivo.note?.trim()]
            .filter((x) => !!x)
            .join(': ')
        : motivo.note?.trim() ||
          (d.reason === FailedVisitReason.OTHER
            ? ETIQUETA_NO_ENTREGA[motivo.reason]
            : null);
    return {
      ...d,
      note: nota,
      userId: quien.userId,
      role: quien.esChofer ? RoleType.DELIVERY : RoleType.ADMIN,
    };
  }

  /**
   * Los avisos de la salida, con todo ya confirmado. Primer intento: los de la
   * postergación (el pedido volvió a aceptado). Segundo: la liberación (un solo
   * aviso al panel, el de la visita fallida), la bandeja de la reprogramación
   * con el día en que quedó y la nueva visita al cliente. Best-effort: un aviso
   * que falla no deshace nada.
   */
  private async avisarSalida(
    sheet: RouteBatch,
    orderId: string,
    outcome: ResultadoDelIntento,
    visita: VisitaFallida,
    hecho: {
      visita: ResultadoDeVisita;
      postergado: Order | null;
      liberado: { pedido: Order; choferAnterior: string | null } | null;
      alAdmin: boolean;
    },
    plan: PlanDeReprogramacion | null,
  ): Promise<void> {
    try {
      if (outcome === 'requeued') {
        if (hecho.postergado) {
          await this.orders.avisarPostergada(
            hecho.postergado,
            sheet.deliveryId as string,
          );
        }
        return;
      }
      const { pedido, choferAnterior } = hecho.liberado as {
        pedido: Order;
        choferAnterior: string | null;
      };
      await this.release.notifyReleased(pedido, choferAnterior, {
        porEntregaFallida: true,
      });
      const r = hecho.visita;
      // Sin día de la hoja la bandeja ya le pide al admin que decida; sin cupo
      // (o al tope) se lo pide el aviso de la visita fallida.
      const sinDia = !hecho.alAdmin && !!plan && !plan.fecha;
      if (plan && !hecho.alAdmin && (sinDia || r.scheduledDate)) {
        this.hoja.avisarReprogramacion(sheet, orderId, plan, r.scheduledDate);
      }
      await this.avisosDeVisita.visitaFallida(
        {
          orderId,
          distributorId: pedido.distributorId,
          customerId: pedido.customerId,
          failedVisitCount: r.failedVisitCount,
          revisitStatus: r.revisitStatus,
          scheduledDate: r.scheduledDate,
          timeSlotId: r.timeSlotId,
        },
        motivoLegible(visita),
        { deHoja: true, adminYaAvisado: sinDia },
      );
    } catch (error) {
      this.logger.warn(
        `Pedido ${orderId}: el intento de la hoja quedó asentado, pero falló un aviso: ${errorMessage(error)}`,
      );
    }
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
          distributorId,
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
