import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type { Point } from 'typeorm';
import { RoleType } from '../common/constants/role-type.enum';
import { conCodigo } from '../common/errors/con-codigo';
import { errorMessage } from '../common/errors/error-message';
import { coordenadasDePunto } from '../common/geo/punto';
import { diaArgentino, sumarDias } from '../common/utils/dias-argentina';
import { DispatchSettingsService } from '../distributor/dispatch-settings.service';
import { DriversGateway } from '../gateways/drivers.gateway';
import {
  DispatchOffer,
  DispatchOfferStatus,
} from '../order/entities/dispatch-offer.entity';
import { RedisService } from '../redis/redis.service';
import { medirConfirmacion } from '../order/domain/delivery-confirmation';
import {
  Order,
  OrderDeliveryMode,
  OrderStatus,
} from '../order/entities/order.entity';
import { RoutePlanningCalendarService } from '../route-batch/application/route-planning-calendar.service';
import { esDiaHabil } from '../route-batch/domain/calendario-laboral';
import { TimeSlotService } from '../time-slot/time-slot.service';
import {
  DeliveryKind,
  ETIQUETA_DE_VISITA_FALLIDA,
  FailedVisitOutcome,
  FailedVisitReason,
  FranjaDelDia,
  HORIZONTE_DE_NUEVA_VISITA,
  NuevaVisitaPropuesta,
  RevisitResolution,
  RevisitStatus,
  decideElAdmin,
  diasCandidatos,
  elegirFranja,
  proponerNuevaVisita,
  puedeFijarElAdmin,
  puedeResponderElCliente,
} from './domain/nueva-visita';
import { OrderFailedVisit } from './entities/order-failed-visit.entity';

/** Códigos de error que reconocen las apps y el panel. */
export const RevisitError = {
  NO_ABIERTA: 'REVISIT_NOT_OPEN',
  DIA_INVALIDO: 'REVISIT_DAY_NOT_AVAILABLE',
  FRANJA_SIN_CUPO: 'REVISIT_SLOT_NOT_AVAILABLE',
  YA_EN_RECORRIDO: 'REVISIT_ALREADY_PLANNED',
  DESPACHANDO: 'ORDER_BEING_DISPATCHED',
} as const;

/** Lo que informa quien no pudo entregar. */
export interface VisitaFallida {
  reason: FailedVisitReason;
  note?: string | null;
  /** Dónde estaba el chofer; un admin no manda ubicación. */
  latitude?: number | null;
  longitude?: number | null;
  accuracyMeters?: number | null;
  /** «Acordé con el cliente»: el día y la franja que eligieron. */
  agreed?: { date: string; timeSlotId: string } | null;
  userId: string;
  role: RoleType;
}

/** En qué quedó el pedido después de la visita fallida. */
export interface ResultadoDeVisita {
  visit: OrderFailedVisit;
  failedVisitCount: number;
  outcome: FailedVisitOutcome;
  revisitStatus: RevisitStatus | null;
  scheduledDate: string | null;
  timeSlotId: string | null;
}

/** Un día con sus franjas con cupo, para que el cliente o el admin elijan. */
export interface DiaDisponible {
  date: string;
  slots: FranjaDelDia[];
  /**
   * Quien informa la entrega fallida puede mandar este día como acordado con el
   * cliente (`agreed`): no en el primer intento de una hoja de ruta, que vuelve
   * a pasar hoy al final del recorrido.
   */
  canAgree: boolean;
}

/** Cómo salió de la hoja la parada que no se pudo entregar. */
export interface VisitaDeHoja extends VisitaFallida {
  orderId: string;
  /** `requeued`: vuelve a pasar hoy; `rescheduled`: salió de la hoja. */
  salida: 'requeued' | 'rescheduled';
  /** El día que le puso la reprogramación de la hoja (`null`: espera al admin). */
  rescheduledTo?: string | null;
  /**
   * Los días en que el pedido puede volver a entrar en una hoja, en orden (el
   * primero es `rescheduledTo`): si ese día no queda franja con cupo, la nueva
   * visita se busca en los siguientes, dentro del horizonte.
   */
  dias?: readonly string[];
  deliveryId: string | null;
}

const NOTA_MAXIMA = 300;

/** Cuántas veces se vuelve a proponer si la franja elegida se llenó al tomarla. */
const INTENTOS_DE_PROPUESTA = 5;

/** El mismo cerrojo que el despacho y la edición del pedido. */
const LOCK_TTL_MS = 5000;
const LOCK_ESPERA_MS = 3000;

/**
 * Visitas fallidas y nueva visita (C5), para todas las entregas. Registra la
 * visita (motivo, ubicación y distancia, como la confirmación de la entrega),
 * cuenta las del pedido, propone el día y la franja según el tipo de entrega
 * respetando el calendario y el cupo de las franjas, y a la segunda deja la
 * decisión al admin. El cliente acepta o elige otro día; el admin fija.
 *
 * No toca el stock (la reserva sigue hasta que el pedido se cancele) ni el
 * pago (lo pagado queda pagado; el efectivo se cobra en la nueva visita). El
 * cambio de estado del pedido lo hace quien llama, por la máquina de estados.
 */
@Injectable()
export class FailedVisitService {
  private readonly logger = new Logger(FailedVisitService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly timeSlots: TimeSlotService,
    private readonly calendario: RoutePlanningCalendarService,
    private readonly dispatchSettings: DispatchSettingsService,
    private readonly redis: RedisService,
    private readonly drivers: DriversGateway,
  ) {}

  /**
   * Pedido suelto o express: asienta la visita y deja en `pedido` (bloqueado
   * por quien llama, que después lo guarda) la cuenta, la nueva visita y el
   * motivo de la transición. No cambia el estado.
   */
  async registrar(
    manager: EntityManager,
    pedido: Order,
    visita: VisitaFallida,
    ahora: Date = new Date(),
  ): Promise<ResultadoDeVisita> {
    const tipo =
      pedido.deliveryMode === OrderDeliveryMode.EXPRESS
        ? DeliveryKind.EXPRESS
        : DeliveryKind.SINGLE;
    const cuenta = (pedido.failedVisitCount ?? 0) + 1;
    const acuerdo = visita.agreed ?? null;
    const alAdmin = decideElAdmin(cuenta);
    // Si decide el admin, el acuerdo del chofer sólo se anota: no se valida.
    if (acuerdo && !alAdmin) {
      await this.validarDiaYFranja(manager, pedido, acuerdo, ahora);
    }

    let outcome: FailedVisitOutcome;
    let propuesta: NuevaVisitaPropuesta | null = null;
    if (alAdmin) {
      outcome = FailedVisitOutcome.AWAITING_ADMIN;
    } else if (acuerdo) {
      outcome = FailedVisitOutcome.AGREED;
      propuesta = { date: acuerdo.date, timeSlotId: acuerdo.timeSlotId };
    } else {
      propuesta = await this.proponer(manager, pedido, tipo, ahora);
      outcome = propuesta
        ? FailedVisitOutcome.PROPOSED
        : FailedVisitOutcome.AWAITING_ADMIN;
    }

    const fila = await this.asentar(manager, pedido, visita, {
      tipo,
      numero: cuenta,
      outcome,
      // Con la decisión en el admin queda anotado lo que acordó el chofer.
      propuesta: propuesta ?? (acuerdo ? { ...acuerdo } : null),
      deliveryId: pedido.deliveryId,
      ahora,
    });

    pedido.failedVisitCount = cuenta;
    pedido.lastFailedVisitAt = ahora;
    pedido.revisitStatus = estadoDe(outcome);
    // Hasta que el admin decida el pedido no tiene día ni franja: ningún
    // camino (despacho, lotes, planificación) lo toma por su agenda vieja.
    pedido.scheduledDate = propuesta?.date ?? null;
    pedido.timeSlotId = propuesta?.timeSlotId ?? null;
    // La relación cargada pisaría la columna al guardar.
    pedido.timeSlot = undefined as unknown as Order['timeSlot'];
    pedido.transitionReason = `No se pudo entregar: ${motivoLegible(visita)}`;
    return {
      visit: fila,
      failedVisitCount: cuenta,
      outcome,
      revisitStatus: estadoDe(outcome),
      scheduledDate: pedido.scheduledDate ?? null,
      timeSlotId: pedido.timeSlotId ?? null,
    };
  }

  /**
   * Antes de que la hoja de ruta saque la parada: ¿con esta visita el pedido
   * llega al tope (decide el admin)? y, si el chofer acordó un día con el
   * cliente, que ese día y esa franja valgan. Lo que no vale corta acá (400 /
   * 409 con `code`) y la parada no sale de la hoja.
   */
  async prepararDeHoja(
    orderId: string,
    salida: 'requeued' | 'rescheduled',
    acuerdo: { date: string; timeSlotId: string } | null | undefined,
    ahora: Date = new Date(),
    enTransaccion?: EntityManager,
  ): Promise<{ alAdmin: boolean }> {
    if (salida === 'requeued') return { alAdmin: false };
    return this.enTransaccion(enTransaccion, async (manager) => {
      const pedido = await this.bloquear(manager, orderId);
      const alAdmin = decideElAdmin((pedido.failedVisitCount ?? 0) + 1);
      if (acuerdo && !alAdmin) {
        await this.validarDiaYFranja(manager, pedido, acuerdo, ahora, {
          deHoja: true,
        });
      }
      return { alAdmin };
    });
  }

  /**
   * Parada de una hoja de ruta. El primer intento (`requeued`) queda en el
   * historial sin contar: el chofer vuelve a pasar en el mismo recorrido. Al
   * salir de la hoja (`rescheduled`) cuenta como visita fallida: con el día que
   * le puso la hoja se le suma la franja (la original si tiene cupo, o la
   * primera libre) y queda propuesta; si ese día las franjas están llenas, el
   * siguiente día de la hoja con cupo dentro del horizonte. Una distribuidora
   * sin franjas propone sólo el día. Sin día, sin cupo en el horizonte o al
   * llegar al tope, decide el admin (sin día ni franja). El estado se revisa
   * con el pedido bloqueado: si mientras tanto se canceló, se entregó o lo tomó
   * otro chofer no se asienta nada (`null`) y no hay nada que avisar.
   *
   * `enTransaccion`: la de la hoja, para que la salida de la parada, la
   * liberación y la visita queden juntas o no quede ninguna.
   */
  async registrarDeHoja(
    v: VisitaDeHoja,
    ahora: Date = new Date(),
    enTransaccion?: EntityManager,
  ): Promise<ResultadoDeVisita | null> {
    return this.enTransaccion(enTransaccion, async (manager) => {
      const pedido = await this.bloquear(manager, v.orderId);
      if (v.salida === 'requeued') {
        // Sigue siendo del chofer de la hoja (aceptado, o en camino todavía).
        if (
          pedido.status !== OrderStatus.ACCEPTED &&
          pedido.status !== OrderStatus.ON_THE_WAY
        ) {
          return null;
        }
        const fila = await this.asentar(manager, pedido, v, {
          tipo: DeliveryKind.ROUTE_SHEET,
          numero: (pedido.failedVisitCount ?? 0) + 1,
          outcome: FailedVisitOutcome.REQUEUED,
          propuesta: null,
          deliveryId: v.deliveryId,
          ahora,
        });
        return {
          visit: fila,
          failedVisitCount: pedido.failedVisitCount ?? 0,
          outcome: FailedVisitOutcome.REQUEUED,
          revisitStatus: (pedido.revisitStatus as RevisitStatus | null) ?? null,
          scheduledDate: pedido.scheduledDate ?? null,
          timeSlotId: pedido.timeSlotId ?? null,
        };
      }
      // La hoja ya lo liberó: tiene que seguir pendiente y sin chofer.
      if (pedido.status !== OrderStatus.PENDING || pedido.deliveryId) {
        return null;
      }

      const cuenta = (pedido.failedVisitCount ?? 0) + 1;
      const acuerdo = v.agreed ?? null;
      const original =
        pedido.timeSlotId ?? (await this.franjaOriginal(manager, pedido));
      let outcome: FailedVisitOutcome;
      let propuesta: NuevaVisitaPropuesta | null = null;
      if (decideElAdmin(cuenta) || !v.rescheduledTo) {
        outcome = FailedVisitOutcome.AWAITING_ADMIN;
      } else if (
        acuerdo &&
        (await this.vale(manager, pedido, acuerdo, ahora, { deHoja: true }))
      ) {
        outcome = FailedVisitOutcome.AGREED;
        propuesta = { date: acuerdo.date, timeSlotId: acuerdo.timeSlotId };
      } else {
        propuesta = await this.proponerDeHoja(
          manager,
          pedido,
          [v.rescheduledTo, ...(v.dias ?? [])],
          original,
          ahora,
        );
        outcome = propuesta
          ? FailedVisitOutcome.PROPOSED
          : FailedVisitOutcome.AWAITING_ADMIN;
      }
      const fila = await this.asentar(manager, pedido, v, {
        tipo: DeliveryKind.ROUTE_SHEET,
        numero: cuenta,
        outcome,
        propuesta: propuesta ?? (acuerdo ? { ...acuerdo } : null),
        deliveryId: v.deliveryId,
        ahora,
      });
      const cambios = {
        failedVisitCount: cuenta,
        lastFailedVisitAt: ahora,
        revisitStatus: estadoDe(outcome) as string | null,
        // Si decide el admin, sin día ni franja hasta que los fije.
        scheduledDate: propuesta?.date ?? null,
        timeSlotId: propuesta?.timeSlotId ?? null,
      };
      await manager.update(Order, { orderId: pedido.orderId }, cambios);
      // Con día propuesto o acordado manda la nueva visita, no la marca de la hoja.
      if (propuesta) await this.soltarMarcaDeHoja(manager, pedido.orderId);
      return {
        visit: fila,
        failedVisitCount: cuenta,
        outcome,
        revisitStatus: estadoDe(outcome),
        scheduledDate: cambios.scheduledDate,
        timeSlotId: cambios.timeSlotId,
      };
    });
  }

  /**
   * Los días con franjas libres para la nueva visita: hoy (lo que queda, si es
   * hábil) y los días hábiles de las próximas dos semanas. Un pedido que salió
   * de una hoja de ruta sólo puede ir a un día posterior a hoy (entra en la hoja
   * de ese día).
   */
  async opciones(
    pedido: Order,
    ahora: Date = new Date(),
  ): Promise<DiaDisponible[]> {
    const hoy = diaArgentino(ahora);
    const cal = await this.calendario.calendario(pedido.distributorId, hoy);
    const deHoja = await this.vieneDeHoja(
      this.dataSource.manager,
      pedido.orderId,
    );
    const dias = [
      ...(deHoja || !esDiaHabil(hoy, cal) ? [] : [hoy]),
      ...diasCandidatos(
        DeliveryKind.SINGLE,
        hoy,
        (d) => esDiaHabil(d, cal),
        sumarDias,
      ),
    ];
    const { canAgree } = await this.contextoDelChofer(pedido.orderId);
    const resultado: DiaDisponible[] = [];
    for (const date of dias) {
      const slots = (await this.franjasDe(pedido.distributorId, date)).filter(
        (f) => f.remaining > 0,
      );
      if (slots.length > 0) resultado.push({ date, slots, canAgree });
    }
    return resultado;
  }

  /**
   * Lo que sabe la app del chofer antes de «No pude entregar»: si es parada de
   * una hoja de ruta en curso y, en ese caso, si es el primer intento (vuelve a
   * pasar hoy: no hay día que acordar).
   */
  async contextoDelChofer(orderId: string): Promise<{
    deliveryKind: DeliveryKind;
    attempt: number;
    canAgree: boolean;
  }> {
    const [parada]: Array<{ intentos: number }> = await this.dataSource.query(
      `SELECT s."failed_attempts" AS "intentos"
         FROM "route_batch_stop" s
         JOIN "route_batch" b ON b."batch_id" = s."batch_id"
        WHERE s."order_id" = $1 AND s."active"
          AND b."kind" = 'planned' AND b."status" = 'assigned'
        LIMIT 1`,
      [orderId],
    );
    if (parada) {
      const attempt = Number(parada.intentos) + 1;
      return {
        deliveryKind: DeliveryKind.ROUTE_SHEET,
        attempt,
        canAgree: attempt > 1,
      };
    }
    const [pedido]: Array<{ modo: string; cuenta: number }> =
      await this.dataSource.query(
        `SELECT "delivery_mode"::text AS "modo", "failed_visit_count" AS "cuenta" FROM "order" WHERE "order_id" = $1`,
        [orderId],
      );
    return {
      deliveryKind:
        pedido?.modo === 'express' ? DeliveryKind.EXPRESS : DeliveryKind.SINGLE,
      attempt: Number(pedido?.cuenta ?? 0) + 1,
      canAgree: true,
    };
  }

  /**
   * «Me sirve»: el cliente acepta el día y la franja propuestos. `cambio`: si
   * esta llamada la confirmó (con el pedido bloqueado); un «Me sirve» repetido
   * o simultáneo devuelve `false` y no se avisa de nuevo.
   */
  aceptar(
    orderId: string,
    userId: string,
  ): Promise<{ pedido: Order; cambio: boolean }> {
    return this.conElDespachoQuieto(orderId, async (manager) => {
      const pedido = await this.bloquear(manager, orderId);
      // Repetir el «Me sirve» no es un error: ya quedó confirmada.
      if (
        pedido.revisitStatus === RevisitStatus.CONFIRMED &&
        pedido.status === OrderStatus.PENDING
      ) {
        return { pedido, retiradas: [], cambio: false };
      }
      if (!puedeResponderElCliente(pedido)) throw noAbierta();
      await this.resolver(manager, pedido, {
        resolution: RevisitResolution.CUSTOMER_ACCEPTED,
        userId,
        date: pedido.scheduledDate ?? null,
        timeSlotId: pedido.timeSlotId ?? null,
      });
      // El día y la franja no cambian: una oferta viva sigue valiendo.
      return { pedido, retiradas: [], cambio: true };
    });
  }

  /** «Elegir otro día y horario»: el cliente cambia la propuesta por un día y una franja con cupo. */
  elegir(
    orderId: string,
    userId: string,
    eleccion: { date: string; timeSlotId: string },
    ahora: Date = new Date(),
  ): Promise<Order> {
    return this.conElDespachoQuieto(orderId, async (manager) => {
      const pedido = await this.bloquear(manager, orderId);
      if (!puedeResponderElCliente(pedido)) throw noAbierta();
      return this.cambiar(manager, pedido, eleccion, ahora, {
        resolution: RevisitResolution.CUSTOMER_CHANGED,
        userId,
      });
    }).then((r) => r.pedido);
  }

  /** El admin fija el día y la franja (también cuando la decisión era suya). */
  fijar(
    orderId: string,
    userId: string,
    eleccion: { date: string; timeSlotId: string },
    ahora: Date = new Date(),
  ): Promise<Order> {
    return this.conElDespachoQuieto(orderId, async (manager) => {
      const pedido = await this.bloquear(manager, orderId);
      if (!puedeFijarElAdmin(pedido)) throw noAbierta();
      return this.cambiar(manager, pedido, eleccion, ahora, {
        resolution: RevisitResolution.ADMIN_SET,
        userId,
      });
    }).then((r) => r.pedido);
  }

  /**
   * Edición del pedido (`PATCH /orders/:id`) que le cambia el día o la franja a
   * uno con una nueva visita abierta: pasa por las mismas reglas que
   * `revisit/choose` y `revisit/schedule`. El cliente sólo mientras es una
   * propuesta (409 `REVISIT_NOT_OPEN` si ya dijo «Me sirve» o decide el admin) y
   * dentro del calendario y el horizonte (400 `REVISIT_DAY_NOT_AVAILABLE`); el
   * admin, siempre. La visita queda confirmada en `pedido` (lo guarda quien
   * llama, que ya tiene el lock del despacho y vence las ofertas vivas).
   */
  async alCambiarLaAgenda(
    manager: EntityManager,
    pedido: Order,
    nueva: { date: string | null | undefined; timeSlotId: string | null },
    actor: { userId: string; esCliente: boolean },
    ahora: Date = new Date(),
  ): Promise<void> {
    if (!pedido.revisitStatus || pedido.status !== OrderStatus.PENDING) return;
    if (actor.esCliente && !puedeResponderElCliente(pedido)) throw noAbierta();
    if (!nueva.date) throw diaInvalido();
    await this.asegurarFueraDeUnRecorrido(manager, pedido.orderId);
    await this.validarDia(pedido, nueva.date, ahora, {
      deHoja: await this.vieneDeHoja(manager, pedido.orderId),
    });
    await this.resolver(manager, pedido, {
      resolution: actor.esCliente
        ? RevisitResolution.CUSTOMER_CHANGED
        : RevisitResolution.ADMIN_SET,
      userId: actor.userId,
      date: nueva.date,
      timeSlotId: nueva.timeSlotId,
    });
  }

  /** El pedido tal como está (para leer la nueva visita o validar al dueño). */
  async pedido(orderId: string): Promise<Order> {
    const pedido = await this.dataSource.manager.findOne(Order, {
      where: { orderId },
      relations: ['timeSlot'],
    });
    if (!pedido) throw new NotFoundException('Pedido no encontrado');
    return pedido;
  }

  // ───────── internos ─────────

  /**
   * Corre el cambio de la nueva visita con el mismo cerrojo que el despacho
   * (`dispatch:offer:<pedido>`): una oferta no se arma con el día de antes ni se
   * inserta después de vencer las vivas. A los choferes cuya oferta se retiró se
   * les avisa después del commit.
   */
  private async conElDespachoQuieto<
    T extends { pedido: Order; retiradas: string[] },
  >(orderId: string, fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    const bloqueo = await this.redis.withLock(
      `dispatch:offer:${orderId}`,
      LOCK_TTL_MS,
      () => this.dataSource.transaction(fn),
      LOCK_ESPERA_MS,
    );
    if (!bloqueo.obtenido) {
      throw conCodigo(
        ConflictException,
        409,
        'El pedido se está despachando en este momento: probá de nuevo en unos segundos',
        RevisitError.DESPACHANDO,
      );
    }
    const { retiradas } = bloqueo.valor;
    for (const driverId of retiradas) {
      try {
        this.drivers.notifyOrderCancelled(driverId, {
          orderId,
          message: 'La entrega cambió de día: la oferta ya no está vigente',
        });
      } catch (error) {
        this.logger.warn(
          `Pedido ${orderId}: no se avisó la oferta retirada: ${errorMessage(error)}`,
        );
      }
    }
    return bloqueo.valor;
  }

  /** Valida y aplica un cambio de día o franja, y vence las ofertas vivas del pedido. */
  private async cambiar(
    manager: EntityManager,
    pedido: Order,
    eleccion: { date: string; timeSlotId: string },
    ahora: Date,
    r: { resolution: RevisitResolution; userId: string },
  ): Promise<{ pedido: Order; retiradas: string[] }> {
    await this.asegurarFueraDeUnRecorrido(manager, pedido.orderId);
    await this.validarDiaYFranja(manager, pedido, eleccion, ahora, {
      deHoja: await this.vieneDeHoja(manager, pedido.orderId),
    });
    const vivas = await manager.find(DispatchOffer, {
      where: { orderId: pedido.orderId, status: DispatchOfferStatus.OFFERED },
    });
    if (vivas.length > 0) {
      await manager.update(
        DispatchOffer,
        { orderId: pedido.orderId, status: DispatchOfferStatus.OFFERED },
        { status: DispatchOfferStatus.SUPERSEDED },
      );
    }
    await this.resolver(manager, pedido, {
      ...r,
      date: eleccion.date,
      timeSlotId: eleccion.timeSlotId,
    });
    return { pedido, retiradas: vivas.map((o) => o.driverId) };
  }

  /** Con la transacción de quien llama, o una propia. */
  private enTransaccion<T>(
    manager: EntityManager | undefined,
    fn: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return manager ? fn(manager) : this.dataSource.transaction(fn);
  }

  private async bloquear(
    manager: EntityManager,
    orderId: string,
  ): Promise<Order> {
    const pedido = await manager
      .createQueryBuilder(Order, 'ord')
      .setLock('pessimistic_write', undefined, ['ord'])
      .where('ord.orderId = :id', { id: orderId })
      .getOne();
    if (!pedido) throw new NotFoundException('Pedido no encontrado');
    return pedido;
  }

  /**
   * Anota la resolución en la última visita fallida, deja la nueva visita
   * confirmada y suelta la marca de la hoja de ruta: desde acá el pedido espera
   * el inicio de su franja, no a la planificación ni al admin.
   */
  private async resolver(
    manager: EntityManager,
    pedido: Order,
    r: {
      resolution: RevisitResolution;
      userId: string;
      date: string | null;
      timeSlotId: string | null;
    },
  ): Promise<void> {
    const ultima = await manager.findOne(OrderFailedVisit, {
      where: { orderId: pedido.orderId },
      order: { failedAt: 'DESC' },
    });
    if (ultima) {
      await manager.update(
        OrderFailedVisit,
        { failedVisitId: ultima.failedVisitId },
        {
          resolution: r.resolution,
          resolvedAt: new Date(),
          resolvedByUserId: r.userId,
          finalDate: r.date,
          finalTimeSlotId: r.timeSlotId,
        },
      );
    }
    await manager.update(
      Order,
      { orderId: pedido.orderId },
      {
        revisitStatus: RevisitStatus.CONFIRMED,
        scheduledDate: r.date,
        timeSlotId: r.timeSlotId,
      },
    );
    await this.soltarMarcaDeHoja(manager, pedido.orderId);
    pedido.revisitStatus = RevisitStatus.CONFIRMED;
    pedido.scheduledDate = r.date;
    pedido.timeSlotId = r.timeSlotId;
  }

  /**
   * La parada que salió de una hoja en la calle deja de retener al pedido
   * (`rescheduled` / `needs_reschedule` lo hacían esperar la planificación o al
   * admin sin importar la fecha): queda como entrega fallida de esa hoja.
   */
  private async soltarMarcaDeHoja(
    manager: EntityManager,
    orderId: string,
  ): Promise<void> {
    await manager.query(
      `UPDATE "route_batch_stop" SET "removed_reason" = 'failed_delivery'
        WHERE "order_id" = $1 AND NOT "active"
          AND "removed_reason"::text IN ('rescheduled', 'needs_reschedule')`,
      [orderId],
    );
  }

  private async proponer(
    manager: EntityManager,
    pedido: Order,
    tipo: DeliveryKind.SINGLE | DeliveryKind.EXPRESS,
    ahora: Date,
  ): Promise<NuevaVisitaPropuesta | null> {
    const hoy = diaArgentino(ahora);
    const cal = await this.calendario.calendario(pedido.distributorId, hoy);
    const dias = diasCandidatos(
      tipo,
      hoy,
      (d) => esDiaHabil(d, cal),
      sumarDias,
    );
    const original =
      pedido.timeSlotId ?? (await this.franjaOriginal(manager, pedido));
    // El cupo se toma con la franja bloqueada, como al crear un pedido: si otra
    // reserva la llenó entre la lectura y el lock, esa franja se descarta y se
    // vuelve a proponer.
    const llenas = new Set<string>();
    for (let intento = 0; intento < INTENTOS_DE_PROPUESTA; intento++) {
      const propuesta = await proponerNuevaVisita(
        tipo,
        dias,
        original,
        async (fecha) =>
          (await this.franjasDe(pedido.distributorId, fecha)).map((f) =>
            llenas.has(`${fecha}/${f.timeSlotId}`) ? { ...f, remaining: 0 } : f,
          ),
      );
      if (!propuesta || !propuesta.timeSlotId) return propuesta;
      const eleccion = {
        date: propuesta.date,
        timeSlotId: propuesta.timeSlotId,
      };
      if (await this.conCupo(manager, pedido, eleccion)) return propuesta;
      llenas.add(`${propuesta.date}/${propuesta.timeSlotId}`);
    }
    return null;
  }

  /**
   * La nueva visita de un pedido que salió de la hoja: el primero de los días de
   * la hoja (`dias`, en orden; sin repetir y dentro del horizonte salvo el
   * primero, que ya eligió la hoja) con una franja con cupo. Una distribuidora
   * sin franjas activas propone sólo el primer día (la hora la calcula la
   * planificación). `null` si ningún día tiene cupo: decide el admin.
   */
  private async proponerDeHoja(
    manager: EntityManager,
    pedido: Order,
    dias: readonly string[],
    original: string | null,
    ahora: Date,
  ): Promise<NuevaVisitaPropuesta | null> {
    const tope = sumarDias(diaArgentino(ahora), HORIZONTE_DE_NUEVA_VISITA);
    const candidatos = [...new Set(dias)].filter(
      (d, i) => i === 0 || d <= tope,
    );
    for (const fecha of candidatos) {
      const franjas = await this.franjasDe(pedido.distributorId, fecha);
      if (franjas.length === 0) {
        return { date: candidatos[0], timeSlotId: null };
      }
      const timeSlotId = await this.tomarFranja(
        manager,
        pedido,
        fecha,
        original,
        franjas,
      );
      if (timeSlotId) return { date: fecha, timeSlotId };
    }
    return null;
  }

  /**
   * La franja de un día ya decidido: la original si tiene cupo, o la primera
   * libre, tomada con la franja bloqueada. `null` si ese día no queda ninguna.
   */
  private async tomarFranja(
    manager: EntityManager,
    pedido: Order,
    fecha: string,
    originalId: string | null,
    delDia?: FranjaDelDia[],
  ): Promise<string | null> {
    let franjas = delDia ?? (await this.franjasDe(pedido.distributorId, fecha));
    for (let intento = 0; intento < INTENTOS_DE_PROPUESTA; intento++) {
      const franja = elegirFranja(franjas, originalId);
      if (!franja) return null;
      const eleccion = { date: fecha, timeSlotId: franja.timeSlotId };
      if (await this.conCupo(manager, pedido, eleccion))
        return franja.timeSlotId;
      franjas = franjas.map((f) =>
        f.timeSlotId === franja.timeSlotId ? { ...f, remaining: 0 } : f,
      );
    }
    return null;
  }

  /** ¿La franja tiene cupo ese día? Con su fila bloqueada hasta el commit. */
  private async conCupo(
    manager: EntityManager,
    pedido: Order,
    eleccion: { date: string; timeSlotId: string },
  ): Promise<boolean> {
    // El mismo día y franja que ya ocupa el pedido no pide otro cupo.
    if (
      pedido.scheduledDate === eleccion.date &&
      pedido.timeSlotId === eleccion.timeSlotId
    ) {
      return true;
    }
    try {
      await this.timeSlots.assertSlotAvailableTx(
        manager,
        eleccion.timeSlotId,
        eleccion.date,
        pedido.distributorId,
      );
      return true;
    } catch (error) {
      if (!(error instanceof BadRequestException)) throw error;
      return false;
    }
  }

  /** ¿El día y la franja valen? (sin lanzar: para lo que ya no se puede rechazar). */
  private async vale(
    manager: EntityManager,
    pedido: Order,
    eleccion: { date: string; timeSlotId: string },
    ahora: Date,
    o: { deHoja?: boolean },
  ): Promise<boolean> {
    try {
      await this.validarDiaYFranja(manager, pedido, eleccion, ahora, o);
      return true;
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      return false;
    }
  }

  /**
   * La franja con la que se pidió: la reprogramación de la hoja la borra del
   * pedido, pero queda en la propuesta de una visita anterior.
   */
  private async franjaOriginal(
    manager: EntityManager,
    pedido: Order,
  ): Promise<string | null> {
    const anterior = await manager.findOne(OrderFailedVisit, {
      where: { orderId: pedido.orderId },
      order: { failedAt: 'DESC' },
    });
    return anterior?.finalTimeSlotId ?? anterior?.proposedTimeSlotId ?? null;
  }

  private async franjasDe(
    distributorId: string,
    fecha: string,
  ): Promise<FranjaDelDia[]> {
    const franjas = await this.timeSlots.getAvailability(fecha, distributorId);
    return franjas.map((f) => ({
      timeSlotId: f.timeSlotId,
      name: f.name,
      startTime: f.startTime,
      endTime: f.endTime,
      remaining: f.remaining,
    }));
  }

  /**
   * El día tiene que ser hábil para la distribuidora (también hoy: un feriado o
   * un día que no reparte no se elige), de hoy en adelante (un pedido que salió
   * de una hoja de ruta, de mañana en adelante) y dentro del horizonte. Hoy,
   * además, sólo si queda una franja vigente con lugar (o la distribuidora no
   * usa franjas).
   */
  private async validarDia(
    pedido: Order,
    fecha: string,
    ahora: Date,
    { deHoja = false }: { deHoja?: boolean } = {},
  ): Promise<void> {
    const hoy = diaArgentino(ahora);
    const cal = await this.calendario.calendario(pedido.distributorId, hoy);
    const desde = deHoja ? sumarDias(hoy, 1) : hoy;
    if (
      fecha < desde ||
      fecha > sumarDias(hoy, HORIZONTE_DE_NUEVA_VISITA) ||
      !esDiaHabil(fecha, cal)
    ) {
      throw diaInvalido();
    }
    if (fecha === hoy) {
      const franjas = await this.franjasDe(pedido.distributorId, hoy);
      if (franjas.length > 0 && !franjas.some((f) => f.remaining > 0)) {
        throw diaInvalido();
      }
    }
  }

  /**
   * El día vale ([validarDia]) y la franja está activa, sin terminar y con cupo
   * (con la fila de la franja bloqueada, como al crear un pedido).
   */
  private async validarDiaYFranja(
    manager: EntityManager,
    pedido: Order,
    eleccion: { date: string; timeSlotId: string },
    ahora: Date,
    o: { deHoja?: boolean } = {},
  ): Promise<void> {
    await this.validarDia(pedido, eleccion.date, ahora, o);
    if (!(await this.conCupo(manager, pedido, eleccion))) {
      throw conCodigo(
        ConflictException,
        409,
        'Esa franja ya no tiene lugar ese día: elegí otra',
        RevisitError.FRANJA_SIN_CUPO,
      );
    }
  }

  /** Un pedido que ya es parada de una hoja armada no cambia de día desde acá. */
  private async asegurarFueraDeUnRecorrido(
    manager: EntityManager,
    orderId: string,
  ): Promise<void> {
    const filas: unknown[] = await manager.query(
      `SELECT 1 FROM "route_batch_stop" s WHERE s."order_id" = $1 AND s."active" LIMIT 1`,
      [orderId],
    );
    if (filas.length > 0) {
      throw conCodigo(
        ConflictException,
        409,
        'El pedido ya está en el recorrido de ese día: no se puede cambiar la visita',
        RevisitError.YA_EN_RECORRIDO,
      );
    }
  }

  /** La última visita fallida fue de una hoja de ruta (el pedido vuelve por otra hoja). */
  private async vieneDeHoja(
    manager: EntityManager,
    orderId: string,
  ): Promise<boolean> {
    const ultima = await manager.findOne(OrderFailedVisit, {
      where: { orderId },
      order: { failedAt: 'DESC' },
    });
    return ultima?.deliveryKind === DeliveryKind.ROUTE_SHEET;
  }

  private async asentar(
    manager: EntityManager,
    pedido: Order,
    visita: VisitaFallida,
    d: {
      tipo: DeliveryKind;
      numero: number;
      outcome: FailedVisitOutcome;
      propuesta: NuevaVisitaPropuesta | null;
      deliveryId: string | null;
      ahora: Date;
    },
  ): Promise<OrderFailedVisit> {
    const medida = await this.medir(manager, pedido, visita);
    const fila = manager.create(OrderFailedVisit, {
      orderId: pedido.orderId,
      distributorId: pedido.distributorId,
      visitNumber: d.numero,
      deliveryKind: d.tipo,
      reason: visita.reason,
      note: visita.note?.trim().slice(0, NOTA_MAXIMA) || null,
      point: medida.point,
      accuracyM: medida.point ? (visita.accuracyMeters ?? null) : null,
      distanceM: medida.distanceM,
      outOfRange: medida.outOfRange,
      reportedByUserId: visita.userId,
      reportedByRole: visita.role,
      deliveryId: d.deliveryId,
      failedAt: d.ahora,
      outcome: d.outcome,
      agreedWithCustomer: !!visita.agreed,
      proposedDate: d.propuesta?.date ?? null,
      proposedTimeSlotId: d.propuesta?.timeSlotId ?? null,
      resolution: null,
      resolvedAt: null,
      resolvedByUserId: null,
      finalDate: null,
      finalTimeSlotId: null,
    });
    return manager.save(fila);
  }

  /** Dónde informó el chofer y a cuántos metros del domicilio (no rechaza: marca). */
  private async medir(
    manager: EntityManager,
    pedido: Order,
    visita: VisitaFallida,
  ): Promise<{
    point: Point | null;
    distanceM: number | null;
    outOfRange: boolean;
  }> {
    const { latitude, longitude } = visita;
    if (latitude == null || longitude == null) {
      return { point: null, distanceM: null, outOfRange: false };
    }
    const { arrivalRadiusMeters } = await this.dispatchSettings.obtener(
      pedido.distributorId,
    );
    let destino = coordenadasDePunto(pedido.deliveryPoint ?? null);
    if (!destino) {
      const [dir]: Array<{ lat: number | null; lng: number | null }> =
        await manager.query(
          `SELECT ST_Y("location"::geometry) AS "lat", ST_X("location"::geometry) AS "lng"
             FROM "user_address" WHERE "address_id" = $1`,
          [pedido.addressId],
        );
      destino =
        dir && dir.lat != null && dir.lng != null
          ? { lat: Number(dir.lat), lng: Number(dir.lng) }
          : null;
    }
    const medida = medirConfirmacion(
      { lat: latitude, lng: longitude },
      destino,
      arrivalRadiusMeters,
    );
    return {
      point: { type: 'Point', coordinates: [longitude, latitude] },
      distanceM: medida.distanceM,
      outOfRange: medida.outOfRange,
    };
  }
}

function estadoDe(outcome: FailedVisitOutcome): RevisitStatus | null {
  switch (outcome) {
    case FailedVisitOutcome.PROPOSED:
      return RevisitStatus.PROPOSED;
    case FailedVisitOutcome.AGREED:
      return RevisitStatus.CONFIRMED;
    case FailedVisitOutcome.AWAITING_ADMIN:
      return RevisitStatus.AWAITING_ADMIN;
    default:
      return null;
  }
}

/** «El cliente no estaba», o «Otro motivo: no había timbre». */
export function motivoLegible(
  v: Pick<VisitaFallida, 'reason' | 'note'>,
): string {
  return [ETIQUETA_DE_VISITA_FALLIDA[v.reason], v.note?.trim()]
    .filter((x) => !!x)
    .join(': ')
    .slice(0, NOTA_MAXIMA);
}

function diaInvalido(): BadRequestException {
  return conCodigo(
    BadRequestException,
    400,
    'Ese día no se puede elegir para la nueva visita: elegí otro',
    RevisitError.DIA_INVALIDO,
  );
}

function noAbierta(): ConflictException {
  return conCodigo(
    ConflictException,
    409,
    'La nueva visita de este pedido ya no se puede cambiar',
    RevisitError.NO_ABIERTA,
  );
}
