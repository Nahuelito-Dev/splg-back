import {
  esperaPagoOnline,
  mensajeDeEspera,
} from '../domain/espera-pago-online';
import { OrderItem } from '../entities/order-item.entity';
import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, In, QueryRunner } from 'typeorm';

import {
  Order,
  OrderDeliveryMode,
  OrderStatus,
} from '../entities/order.entity';
import { User } from '../../users/entities/user.entity';
import { DeliveryService } from '../../delivery/delivery.service';
import { NotificationPort } from '../domain/ports/notification.port';
import { transitionOrder } from '../domain/order-status.machine';
import { marcarOfrecible } from '../domain/vencimiento-sin-chofer';
import { assertReservaActivable } from '../domain/reservation-activation';
import { generateDeliveryCode } from '../domain/delivery-code.util';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import { CylinderLifecyclePort } from '../domain/ports/cylinder-lifecycle.port';
import { StockDeliveryPort } from '../domain/ports/stock-delivery.port';
import { DispatchOfferRepositoryPort } from '../domain/ports/dispatch-offer.repository.port';
import { DispatchOfferStatus } from '../entities/dispatch-offer.entity';
import {
  EVENTO_PEDIDO_ENTREGADO,
  PedidoEntregadoEvent,
} from '../domain/events/pedido-entregado.event';
import { ahoraDeLaBase } from '../../common/utils/ahora-de-la-base';
import { TruckLoadGatePort } from '../domain/ports/truck-load-gate.port';
import { DispatchOrchestratorService } from './dispatch-orchestrator.service';
import { ReleaseOrderUseCase } from './release-order.use-case';
import {
  CancelOrderUseCase,
  mapRoleToCancelActor,
} from './cancel-order.use-case';
import { RoleType } from '../../common/constants/role-type.enum';
import { errorMessage } from '../../common/errors/error-message';
import { bloquearChoferVigente } from '../../common/locks/chofer-lock';
import { FleetDispatchLockService } from '../../fleet/fleet-dispatch-lock.service';
import { EntityPhotoService } from '../../s3/entity-photo.service';
import { GasCylinder } from '../../gascylinder/entities/gascylinder.entity';
import { AuditoriaDeDatos } from '../../audit/data/auditoria-de-datos';
import { AuditActionTypeId } from '../../audit/entities/audit-action-type.entity';
import { CustomerContainerService } from '../../customer-container/customer-container.service';
import { CustomerContainerMovementReason } from '../../customer-container/entities/customer-container-movement.entity';
import {
  idCortoDePedido,
  pedirAvisoAlAdmin,
} from '../../common/events/aviso-al-admin';
import {
  MOTIVO_ENTREGA_MANUAL_MAX,
  MOTIVO_ENTREGA_MANUAL_MIN,
} from '../dto/update-order-status.dto';

/** Resultado de aplicar los efectos de un estado dentro de la transacción. */
interface EfectosDelEstado {
  deliveryUser: User | null;
  /** `user_id` del chofer que aceptó, para cerrar su oferta tras el commit. */
  aceptacionDelChoferUserId: string | null;
  /** `user_id` de los choferes a quienes se les retiró la oferta del pedido. */
  ofertasRetiradas: string[];
}

/** Tope para firmar la foto del chofer en el evento de socket. */
const FIRMA_TIMEOUT_MS = 500;

const SIN_EFECTOS: EfectosDelEstado = {
  deliveryUser: null,
  aceptacionDelChoferUserId: null,
  ofertasRetiradas: [],
};

/** Evento de tiempo real emitido al cliente por cada estado del pedido. */
const STATUS_EVENT: Partial<Record<OrderStatus, string>> = {
  [OrderStatus.ACCEPTED]: 'order:accepted',
  [OrderStatus.ON_THE_WAY]: 'order:on-the-way',
  [OrderStatus.DELIVERED]: 'order:delivered',
  [OrderStatus.CANCELLED]: 'order:cancelled',
};

/**
 * Eventos del ciclo de vida que recibe el panel. Mismos nombres que los del
 * cliente; `pending` es el pedido liberado que vuelve a buscar chofer.
 */
const ADMIN_STATUS_EVENT: Partial<Record<OrderStatus, string>> = {
  ...STATUS_EVENT,
  [OrderStatus.PENDING]: 'order:pending',
};

/**
 * Caso de uso: avanzar el estado de un pedido (chofer/admin).
 *
 * Valida la transición contra la máquina de estados de dominio, aplica los
 * efectos de cada estado (asignar chofer, timestamps, marcar pagado en CASH) y
 * dispara los side-effects de tiempo real y notificación (best-effort).
 *
 * Extraído de OrderService para respetar SRP: la orquestación de la transición
 * vive en la capa application/, no mezclada con las lecturas del service.
 */
/** 409 de tomar suelto un pedido que es parada de un lote de recorrido vivo (M4). */
export const MENSAJE_PEDIDO_EN_RECORRIDO =
  'El pedido es parte de un recorrido que se le está ofreciendo a un chofer: no se puede tomar suelto';

/** 409 de aceptar un pedido con otro ya aceptado en espera (CU-013). */
export const MENSAJE_PEDIDO_ENCOLADO =
  'Ya tenés un pedido aceptado esperando: terminá el actual antes de tomar otro';

@Injectable()
export class UpdateOrderStatusUseCase {
  private readonly logger = new Logger(UpdateOrderStatusUseCase.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly deliveries: DeliveryService,
    private readonly dispatch: RealtimeDispatchPort,
    private readonly notificationService: NotificationPort,
    private readonly orders: OrderRepositoryPort,
    private readonly dispatchOrchestrator: DispatchOrchestratorService,
    private readonly cylinderLifecycle: CylinderLifecyclePort,
    private readonly cancelOrderUseCase: CancelOrderUseCase,
    private readonly releaseOrderUseCase: ReleaseOrderUseCase,
    // Gate único de bloqueo de flota (CU-136 a CU-138), el mismo que usan
    // `OrderService.assignDelivery` y el despacho automático: aceptar por
    // esta vía (admin con deliveryId, o el propio chofer desde el pool)
    // tampoco puede darle el pedido a un chofer inhabilitado.
    private readonly fleetGate: FleetDispatchLockService,
    // Stock físico: la entrega descuenta la llena del camión o del depósito.
    private readonly stockDelivery: StockDeliveryPort,
    // La foto del chofer sale firmada en el tracking del cliente.
    private readonly fotos: EntityPhotoService,
    // D5: con control de carga activo, el chofer necesita una carga de camión abierta para aceptar.
    private readonly truckLoadGate: TruckLoadGatePort,
    // Ofertas de despacho: tomar un pedido del pool retira las de los demás choferes.
    private readonly offers: DispatchOfferRepositoryPort,
    // Avisa "pedido entregado" a quien le interese (cuenta corriente, comisiones).
    private readonly eventos: EventEmitter2,
    private readonly customerContainers: CustomerContainerService,
  ) {}

  async execute(
    id: string,
    status: OrderStatus,
    deliveryId?: string,
    role?: RoleType,
    actorUserId?: string,
    reason?: string,
  ): Promise<Order> {
    // La entrega es la prueba de que el cliente recibió el pedido: se confirma
    // con el QR del chofer (`ConfirmDeliveryUseCase`, que llega acá SIN rol) o
    // la cierra un administrador. El chofer no puede cerrarla por su cuenta.
    if (status === OrderStatus.DELIVERED && role === RoleType.DELIVERY) {
      throw new ForbiddenException(
        'La entrega se confirma con el QR del cliente',
      );
    }

    // La entrega manual del administrador no tiene la prueba del QR: queda
    // asentada con el motivo (historial de estados y auditoría). La que llega
    // sin rol es la del QR, que ya tiene su prueba.
    const motivoDeEntrega = this.motivoDeEntregaManual(status, role, reason);

    // Cancelar por ESTE endpoint tiene que producir EXACTAMENTE el mismo
    // efecto que `PATCH /orders/:id/cancel` (mismo stock, mismos avisos, sin
    // doble devolución si se reintenta): delega por completo en
    // CancelOrderUseCase en vez de duplicar su política. Antes este caso
    // caía en el `default` de `applyStatusEffects` y no devolvía stock.
    if (status === OrderStatus.CANCELLED) {
      if (!actorUserId) {
        throw new BadRequestException(
          'No se puede cancelar sin el id del usuario que lo solicita',
        );
      }
      return this.cancelOrderUseCase.execute(
        id,
        actorUserId,
        mapRoleToCancelActor(role),
        reason,
      );
    }

    if (status === OrderStatus.PENDING) {
      return this.handlePendingTarget(id, deliveryId, role);
    }

    // ACCEPTED / ON_THE_WAY / DELIVERED: la carrera real (segunda revisión,
    // punto 2) es que alguien cancele el pedido MIENTRAS esto se procesa. Se
    // re-lee con el MISMO lock pesimista que cancelar/liberar
    // (`FOR UPDATE OF "ord"`, ver `CancelOrderUseCase`/`ReleaseOrderUseCase`)
    // dentro de una transacción, y la transición se valida con el dato
    // FRESCO que trae el lock: si la cancelación concurrente ya hizo commit,
    // `transitionOrder` ve el estado terminal y corta con 400 acá, en vez de
    // pisarla silenciosamente con datos leídos antes de que el lock existiera.
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let order: Order;
    let deliveryUser: User | null;
    // Chofer cuya aceptación hay que dejar registrada en el despacho: se hace
    // DESPUÉS del commit (ver abajo).
    let aceptacionADespachar: string | null = null;
    let ofertasRetiradas: string[] = [];
    try {
      const locked = await queryRunner.manager
        .createQueryBuilder(Order, 'ord')
        .setLock('pessimistic_write', undefined, ['ord'])
        .leftJoinAndSelect('ord.delivery', 'delivery')
        .where('ord.orderId = :id', { id })
        .getOne();

      // Los renglones se leen DESPUÉS del lock y aparte: un SELECT con JOIN que
      // esperó el lock re-lee el pedido pero no los renglones que una edición
      // cambió en el medio (READ COMMITTED), y el `save` con cascade
      // desvincularía los renglones nuevos.
      if (!locked) {
        throw new NotFoundException('Pedido no encontrado');
      }
      locked.items = await queryRunner.manager.find(OrderItem, {
        where: { orderId: locked.orderId },
      });

      // Antes de tocar nada: el pedido tiene que ser de quien lo está moviendo.
      await this.assertPedidoDelChofer(locked, deliveryId, role);

      // Dominio: valida que la transición sea legal (PENDING→ACCEPTED→ON_THE_WAY
      // →DELIVERED) y la aplica. Rechaza saltos/estados terminales con 400.
      const previousStatus = locked.status;
      transitionOrder(locked, status);
      const efectos = await this.applyStatusEffects(
        locked,
        status,
        previousStatus,
        queryRunner.manager,
        deliveryId,
        role,
      );
      deliveryUser = efectos.deliveryUser;
      aceptacionADespachar = efectos.aceptacionDelChoferUserId;
      ofertasRetiradas = efectos.ofertasRetiradas;

      // El historial de estados lo asienta el subscriber con este motivo.
      if (motivoDeEntrega) locked.transitionReason = motivoDeEntrega;
      order = await queryRunner.manager.save(locked);
      if (motivoDeEntrega) {
        await this.asentarEntregaManual(
          queryRunner.manager,
          order,
          motivoDeEntrega,
        );
      }
      await queryRunner.commitTransaction();
    } catch (e) {
      await this.rollbackSeguro(queryRunner);
      throw e;
    } finally {
      await queryRunner.release();
    }

    // La constancia de la oferta escribe en `order_dispatch_offer` por OTRA
    // conexión del pool, y esa tabla tiene una FK al pedido: el chequeo de
    // la FK pide `FOR KEY SHARE` sobre la fila que esta transacción tenía
    // bloqueada con `FOR UPDATE`. Hecho adentro, la transacción esperaba a
    // esa escritura y la escritura a la transacción: un deadlock de
    // aplicación que Postgres no detecta (queda `idle in transaction` para
    // siempre). Por eso va acá, con el lock ya liberado. Best-effort.
    if (aceptacionADespachar) {
      await this.dispatchOrchestrator
        .onDriverAccepted(order.orderId, aceptacionADespachar)
        .catch(() => undefined);
    }

    for (const driverUserId of ofertasRetiradas) {
      this.dispatch.notifyDriverOrderCancelled(driverUserId, {
        orderId: order.orderId,
        message: 'El pedido ya fue tomado: la oferta ya no está vigente',
      });
    }

    if (status === OrderStatus.DELIVERED) {
      await this.publicarEntrega(order);
      await this.avisarFaltantesDeVacias(order);
    }

    await this.emitStatusEvent(order, status, deliveryUser);
    // Panel admin en vivo, sólo a los admins DE ESA distribuidora (+ super
    // admin, que ven todas). El nombre sale de una tabla, no del enum: un
    // estado nuevo no crea un evento sin decidirlo.
    const adminEvent = ADMIN_STATUS_EVENT[status];
    if (adminEvent) {
      this.dispatch.notifyAdmins(
        adminEvent,
        {
          orderId: order.orderId,
          distributorId: order.distributorId,
          status: order.status,
          totalAmount: order.totalAmount,
        },
        order.distributorId,
      );
    }
    await this.notifyCustomer(order);

    return order;
  }

  /**
   * Avisa que el pedido se entregó (ya confirmado en la base). Quien escucha
   * asienta el cargo a cuenta corriente y la comisión del chofer; si un oyente
   * falla o el proceso se cae acá, el barrido nocturno recupera el asiento
   * (ambos son idempotentes por pedido). Nunca rompe la entrega.
   */
  private async publicarEntrega(order: Order): Promise<void> {
    if (!order.deliveredAt) return;
    try {
      await this.eventos.emitAsync(
        EVENTO_PEDIDO_ENTREGADO,
        new PedidoEntregadoEvent(
          order.orderId,
          order.distributorId,
          order.deliveryId,
          order.customerId,
          order.paymentMethod,
          order.totalAmount,
          order.deliveredAt,
        ),
      );
    } catch (error) {
      this.logger.error(
        `Falló un oyente de la entrega del pedido ${order.orderId}: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Aviso al panel si el cliente devolvió menos vacías que las esperadas. El nombre del cliente y de los tipos se leen
   * aparte (no se suman al pedido que devuelve el endpoint); si la lectura falla, se avisa igual con textos genéricos.
   */
  private async avisarFaltantesDeVacias(order: Order): Promise<void> {
    const faltantes = (order.items ?? []).flatMap((item) => {
      const expected = item.quantity - item.containersCharged;
      const received = item.emptiesReceived ?? expected;
      const missing = expected - received;
      return missing > 0 ? [{ item, missing }] : [];
    });
    if (faltantes.length === 0) return;
    let customer = 'El cliente';
    const tipos = new Map<string, string>();
    try {
      const [cliente, cilindros] = await Promise.all([
        this.dataSource
          .getRepository(User)
          .findOne({ where: { userId: order.customerId } }),
        this.dataSource.getRepository(GasCylinder).find({
          where: {
            gasCylinderId: In(faltantes.map(({ item }) => item.gasCylinderId)),
          },
          withDeleted: true,
        }),
      ]);
      if (cliente?.fullName) customer = cliente.fullName;
      for (const c of cilindros) tipos.set(c.gasCylinderId, c.type);
    } catch (e) {
      this.logger.warn(
        `No se pudieron leer los nombres para el aviso de vacías: ${(e as Error).message}`,
      );
    }
    const detail = faltantes
      .map(
        ({ item, missing }) =>
          `${missing} envase(s) de ${tipos.get(item.gasCylinderId) ?? 'tipo desconocido'}`,
      )
      .join(', ');
    pedirAvisoAlAdmin(this.eventos, this.logger, {
      distributorId: order.distributorId,
      kind: 'empties_shortfall',
      title: 'Faltante de envases en una entrega',
      body: `${customer} no devolvió ${detail} en el pedido #${idCortoDePedido(order.orderId)}`,
      link: { entity: 'order', id: order.orderId },
      dedupeKey: `empties-shortfall:${order.orderId}`,
    });
  }

  /** El motivo de una entrega manual del admin (400 si falta o es muy corto); `null` si no aplica. */
  private motivoDeEntregaManual(
    status: OrderStatus,
    role?: RoleType,
    reason?: string,
  ): string | null {
    if (status !== OrderStatus.DELIVERED) return null;
    if (role !== RoleType.ADMIN && role !== RoleType.SUPER_ADMIN) return null;
    const motivo = reason?.trim() ?? '';
    if (motivo.length < MOTIVO_ENTREGA_MANUAL_MIN) {
      throw new BadRequestException(
        `Motivo: indicá el motivo de la entrega manual (al menos ${MOTIVO_ENTREGA_MANUAL_MIN} caracteres)`,
      );
    }
    if (motivo.length > MOTIVO_ENTREGA_MANUAL_MAX) {
      throw new BadRequestException(
        `Motivo: hasta ${MOTIVO_ENTREGA_MANUAL_MAX} caracteres`,
      );
    }
    return motivo;
  }

  /** Auditoría de datos del motivo, en la transacción de la entrega manual. */
  private async asentarEntregaManual(
    manager: EntityManager,
    order: Order,
    motivo: string,
  ): Promise<void> {
    await AuditoriaDeDatos.registrar(manager, {
      actionTypeId: AuditActionTypeId.UPDATE,
      entity: Order.name,
      recordId: order.orderId,
      distributorId: order.distributorId,
      details: [
        {
          field: 'manualDeliveryReason',
          oldValue: null,
          newValue: motivo,
        },
      ],
    });
  }

  /**
   * Rollback que nunca tapa el error original ni deja la conexión sin
   * liberar: si la transacción ya no está activa (o la conexión se cayó) el
   * rollback tira, y ese error pisaría al verdadero.
   */
  private async rollbackSeguro(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive) return;
    try {
      await queryRunner.rollbackTransaction();
    } catch (err) {
      this.logger.error(`Falló el rollback: ${errorMessage(err)}`);
    }
  }

  /**
   * `status: pending` tiene DOS significados según de dónde viene el pedido,
   * y cada uno tiene su propio camino:
   *  - RESERVED → PENDING: activación MANUAL de una reserva. Exige las
   *    MISMAS condiciones que el cron (`ReservationService.activateDueReservations`):
   *    seña paga y día agendado cumplido. Sin esto, este endpoint sería un
   *    segundo camino que se salta la política de reservas.
   *  - ACCEPTED/ON_THE_WAY → PENDING: liberar al chofer asignado (admin que
   *    destraba a mano, o el propio chofer). Delega por completo en el
   *    camino ÚNICO de liberación (`ReleaseOrderUseCase`), el mismo que usa
   *    `PATCH /cancel` (chofer).
   */
  private async handlePendingTarget(
    id: string,
    deliveryId?: string,
    role?: RoleType,
  ): Promise<Order> {
    const order = await this.orders.findByIdFull(id);
    if (!order) throw new NotFoundException('Pedido no encontrado');

    if (order.status === OrderStatus.RESERVED) {
      // Activar una reserva es una operación administrativa (mismo nivel que
      // `confirmDeposit`); un chofer no tiene por qué conocer una reserva
      // ajena (todavía sin despachar) ni activarla a mano.
      if (role === RoleType.DELIVERY) {
        throw new ForbiddenException(
          'Sólo un administrador puede activar una reserva',
        );
      }
      return this.activarReservaConLock(id);
    }

    // Liberar un pedido con chofer asignado: quién pide tiene que poder
    // tocarlo (mismo chequeo que el resto de las transiciones del chofer).
    await this.assertPedidoDelChofer(order, deliveryId, role);
    // Punto 6 (segunda revisión): el DUEÑO se revalida DENTRO del lock de
    // `ReleaseOrderUseCase`, con el dato fresco — este chequeo de arriba es
    // sólo un rechazo rápido (403 sin abrir transacción) con el dato que
    // había ANTES de pedir el lock. Para un chofer, el parámetro `deliveryId`
    // que llega acá YA es su propio `user_id` (lo resuelve el controller,
    // ver `OrderController.updateStatus`); para un admin no hay dueño que
    // validar, puede liberar cualquier pedido.
    const expectedDriverUserId =
      role === RoleType.DELIVERY ? deliveryId : undefined;
    return this.releaseOrderUseCase.execute(id, expectedDriverUserId);
  }

  /**
   * Activa una reserva a mano con el MISMO lock pesimista que cancelar/
   * liberar: la carrera real (segunda revisión, punto 7) es contra el CRON
   * (`ReservationService.activateDueReservations`), que corre cada minuto y
   * puede ganarle a un admin que activa a mano al mismo tiempo. Sin el lock,
   * los dos leerían `RESERVED`, los dos ofertarían → el pedido queda con DOS
   * ofertas vigentes. Con el lock: el segundo en llegar ve, con el dato
   * fresco, que ya no está `RESERVED` (el primero ya la activó y ofertó) y
   * NO vuelve a ofertar — devuelve el pedido tal como quedó, de forma
   * idempotente, en vez de duplicar el despacho.
   */
  private async activarReservaConLock(id: string): Promise<Order> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let order: Order;
    let yaActivada: boolean;
    try {
      const locked = await queryRunner.manager
        .createQueryBuilder(Order, 'ord')
        .setLock('pessimistic_write', undefined, ['ord'])
        .where('ord.orderId = :id', { id })
        .getOne();

      // Los renglones se leen DESPUÉS del lock y aparte: un SELECT con JOIN que
      // esperó el lock re-lee el pedido pero no los renglones que una edición
      // cambió en el medio (READ COMMITTED), y el `save` con cascade
      // desvincularía los renglones nuevos.
      if (!locked) {
        throw new NotFoundException('Pedido no encontrado');
      }
      locked.items = await queryRunner.manager.find(OrderItem, {
        where: { orderId: locked.orderId },
      });

      yaActivada = locked.status !== OrderStatus.RESERVED;
      if (!yaActivada) {
        assertReservaActivable(locked);
        transitionOrder(locked, OrderStatus.PENDING);
        marcarOfrecible(locked);
      }

      order = await queryRunner.manager.save(locked);
      await queryRunner.commitTransaction();
    } catch (e) {
      await this.rollbackSeguro(queryRunner);
      throw e;
    } finally {
      await queryRunner.release();
    }

    // Si ganó el cron la carrera, el pedido ya está ofertado por él: no
    // duplicamos el despacho ni el aviso.
    if (!yaActivada) {
      // Despacho automático, igual que hace el cron al activar.
      await this.dispatchOrchestrator
        .offerToNextDriver(order)
        .catch(() => undefined);
      this.dispatch.notifyAdmins(
        'order:pending',
        { orderId: order.orderId, status: order.status },
        order.distributorId,
      );
    }
    return order;
  }

  /**
   * Un chofer solo puede mover pedidos que ya son suyos.
   *
   * Solo se aplica al rol chofer: el administrador mueve cualquier pedido, que
   * es su trabajo, y reasigna por la operación dedicada.
   *
   * Si el pedido **todavía no tiene chofer**, no hay nada que verificar:
   * aceptarlo es justamente la forma en que se asigna, y ese es el camino
   * normal del despacho. Si ya lo tiene, el que llama tiene que ser ese mismo,
   * lo que cubre dos cosas a la vez: cerrar la entrega de un pedido ajeno, y
   * aceptar uno que el despacho o el administrador ya le habían dado a otro.
   *
   * El identificador se resuelve por perfil de reparto o por usuario porque el
   * chofer llega identificado por su `user_id` mientras que el pedido guarda el
   * `delivery_id`. Es la misma resolución que hace el alta de la aceptación.
   */
  private async assertPedidoDelChofer(
    order: Order,
    deliveryId?: string,
    role?: RoleType,
  ): Promise<void> {
    if (role !== RoleType.DELIVERY || !deliveryId) return;
    if (!order.deliveryId) return;

    const delivery = await this.deliveries.buscarPorIdOUsuario(deliveryId);

    if (!delivery || delivery.deliveryId !== order.deliveryId) {
      throw new ForbiddenException('Este pedido no está asignado a tu usuario');
    }
  }

  /**
   * Aplica los efectos de dominio de cada estado sobre el pedido y devuelve el
   * usuario-chofer asociado (para el payload de tiempo real), si aplica.
   */
  private async applyStatusEffects(
    order: Order,
    status: OrderStatus,
    previousStatus: OrderStatus,
    manager: EntityManager,
    deliveryId?: string,
    role?: RoleType,
  ): Promise<EfectosDelEstado> {
    switch (status) {
      case OrderStatus.ACCEPTED: {
        // Ni el chofer ni el admin toman un pedido que espera el pago online.
        if (esperaPagoOnline(order)) {
          throw new ConflictException(mensajeDeEspera(order));
        }
        // Una parada de un recorrido que se está ofreciendo completo no se toma
        // suelta (ni del pool ni a mano): el lote se acepta entero o se deshace.
        if (await this.offers.isInLiveBatch(order.orderId)) {
          throw new ConflictException(MENSAJE_PEDIDO_EN_RECORRIDO);
        }
        if (!deliveryId || deliveryId.trim() === '') {
          throw new BadRequestException(
            'Se requiere un repartidor para aceptar el pedido',
          );
        }

        const delivery = await this.deliveries.buscarPorIdOUsuario(
          deliveryId,
          true,
        );

        // El chofer tiene que ser de la misma distribuidora que el pedido.
        if (!delivery || delivery.distributorId !== order.distributorId) {
          throw new NotFoundException('Repartidor no encontrado');
        }
        // Mismo gate que la asignación manual (`assignDelivery`): habilitado
        // y validado. No exige que esté en línea.
        this.deliveries.assertElegibleParaAsignacion(delivery);
        // Con el chofer bloqueado (el mismo lock que `ponerEnUso`, la baja y
        // la asignación a mano): el vehículo que se lee abajo no cambia hasta
        // el commit, y una baja que ganó la carrera se ve acá.
        if (!(await bloquearChoferVigente(manager, delivery.deliveryId))) {
          throw new NotFoundException('Repartidor no encontrado');
        }
        // Y el mismo gate de flota (CU-136 a CU-138): la licencia propia o el
        // vehículo que maneja no pueden tener un documento bloqueante vencido.
        // Se aplica tanto si acepta el admin (con `deliveryId`) como si acepta
        // el propio chofer desde el pool (`GET /orders/available`).
        await this.fleetGate.assertChoferHabilitado(
          delivery.userId,
          order.distributorId,
        );
        // Un pedido express (CU-149) sólo lo lleva un chofer con una moto en uso.
        if (order.deliveryMode === OrderDeliveryMode.EXPRESS) {
          await this.fleetGate.assertEnMoto(
            delivery.userId,
            order.distributorId,
          );
        }
        // D5: si la distribuidora exige carga de camión abierta, el chofer sin
        // ella no acepta (repetir una aceptación que ya era suya no se vuelve a
        // controlar).
        if (
          !(
            previousStatus === OrderStatus.ACCEPTED &&
            order.deliveryId === delivery.deliveryId
          )
        ) {
          await this.truckLoadGate.assertPuedeAceptar(
            order.distributorId,
            delivery.deliveryId,
            manager,
          );
        }
        // CU-013: un chofer que está por terminar su entrega puede tomar UN
        // pedido más, nunca dos encolados. Lo controla el propio chofer; el
        // administrador asigna a su criterio.
        if (
          role === RoleType.DELIVERY &&
          !(
            previousStatus === OrderStatus.ACCEPTED &&
            order.deliveryId === delivery.deliveryId
          )
        ) {
          const enCurso = await this.orders.findInProgressOfDeliveries([
            delivery.deliveryId,
          ]);
          if (
            enCurso.some(
              (p) =>
                p.orderId !== order.orderId &&
                p.status === OrderStatus.ACCEPTED,
            )
          ) {
            throw new ConflictException(MENSAJE_PEDIDO_ENCOLADO);
          }
        }
        // Snapshot del vehículo en uso (decisión de nahue del 30/09): a
        // esta altura el chofer ya pasó el gate, así que si tiene
        // vehículo, no viene inhabilitado.
        const vehiculo = await this.fleetGate.vehiculoEnUsoDelChofer(
          delivery.userId,
          order.distributorId,
        );
        order.vehicleCarId = vehiculo?.carId ?? null;
        order.vehiclePatent = vehiculo?.patent ?? null;
        order.vehicleBrand = vehiculo?.brand ?? null;
        order.vehicleModel = vehiculo?.model ?? null;

        // Idempotencia (H-55): si YA estaba ACCEPTED con este mismo chofer
        // (típicamente porque "aceptó" el aviso de una asignación manual,
        // que no era una oferta real), no reprocesar: no regenerar
        // `acceptedAt` ni `deliveryCode`, ni volver a cerrar una oferta que
        // nunca existió.
        let aceptacionDelChoferUserId: string | null = null;
        let ofertasRetiradas: string[] = [];
        const yaAceptadoPorEsteChofer =
          previousStatus === OrderStatus.ACCEPTED &&
          order.deliveryId === delivery.deliveryId;

        if (!yaAceptadoPorEsteChofer) {
          order.deliveryId = delivery.deliveryId;
          // `order.delivery` (la relación) y `order.deliveryId` (la columna)
          // apuntan a la MISMA columna `delivery_id`: si se reasigna de un
          // chofer a otro y sólo se pisa `deliveryId`, TypeORM prioriza el
          // valor de la relación (el chofer viejo) al guardar. Ver el mismo
          // fix en `releaseDriverAssignment`/`OrderService.assignDelivery`.
          order.delivery = delivery;
          order.acceptedAt = await ahoraDeLaBase(manager);
          // Prueba de entrega con QR: se genera acá el código secreto que el
          // chofer mostrará en su QR y el cliente escaneará para confirmar la
          // entrega (ver ConfirmDeliveryUseCase). Ya queda listo para cuando
          // el pedido pase a ON_THE_WAY.
          order.deliveryCode = generateDeliveryCode();

          // La oferta de despacho se cierra como ACCEPTED después del commit
          // (el offer.driver_id es el user_id, el mismo que usa el GEO/WS).
          aceptacionDelChoferUserId = delivery.userId;
          // Las ofertas abiertas a los demás choferes se retiran en esta misma
          // transacción: el pedido ya tiene dueño.
          ofertasRetiradas = await this.offers.withdrawOtherActiveOffers(
            manager,
            order.orderId,
            delivery.userId,
            DispatchOfferStatus.SUPERSEDED,
          );
        }

        return {
          deliveryUser: delivery.user,
          aceptacionDelChoferUserId,
          ofertasRetiradas,
        };
      }

      case OrderStatus.ON_THE_WAY: {
        order.onTheWayAt = await ahoraDeLaBase(manager);
        if (!order.deliveryId) return SIN_EFECTOS;
        const existingDelivery = await this.deliveries.buscarPorIdOUsuario(
          order.deliveryId,
          true,
        );
        // Activa el tracking en vivo: el GPS de este chofer se reenviará al
        // cliente mientras esté en camino.
        if (existingDelivery?.user) {
          this.dispatch.startTracking(
            existingDelivery.user.userId,
            order.orderId,
            order.customerId,
            order.distributorId,
          );
        }
        return {
          deliveryUser: existingDelivery?.user ?? null,
          aceptacionDelChoferUserId: null,
          ofertasRetiradas: [],
        };
      }

      case OrderStatus.DELIVERED: {
        order.deliveredAt = await ahoraDeLaBase(manager);
        // Corta el tracking del chofer que entregó.
        if (order.deliveryId) {
          const del = await this.deliveries.buscarPorIdOUsuario(
            order.deliveryId,
            true,
          );
          if (del?.user) this.dispatch.stopTracking(del.user.userId);
        }
        // Ciclo del envase: avanza los envases despachados en este pedido a
        // WITH_CUSTOMER (no-op si no hay). Va por el MISMO manager y es
        // atómico con la entrega: por otra conexión esperaría el lock del
        // pedido (FK) y dejaría los envases a medias.
        const advanced = await this.cylinderLifecycle.onOrderDelivered(
          order.orderId,
          order.distributorId,
          manager,
        );
        if (advanced > 0) {
          this.logger.log(
            `Pedido ${order.orderId} entregado: ${advanced} envase(s) → with_customer`,
          );
        }
        for (const item of order.items ?? []) {
          if ((item.containersCharged ?? 0) > 0) {
            await this.customerContainers.registrar(manager, {
              distributorId: order.distributorId,
              customerUserId: order.customerId,
              gasCylinderId: item.gasCylinderId,
              quantity: item.containersCharged,
              reason: CustomerContainerMovementReason.PURCHASED,
              orderId: order.orderId,
            });
          }
        }
        // Stock físico (D5, D6): sale la llena del camión del chofer o del
        // depósito y entra la vacía de canje. También por el MISMO manager:
        // por otra conexión esperaría el lock del pedido (FK). Nunca bloquea
        // la entrega: si no hay saldo, queda para la conciliación.
        await this.stockDelivery.onOrderDelivered(manager, {
          orderId: order.orderId,
          distributorId: order.distributorId,
          vehicleCarId: order.vehicleCarId,
          items: (order.items ?? []).map((i) => ({
            gasCylinderId: i.gasCylinderId,
            quantity: i.quantity,
            containersCharged: i.containersCharged,
            emptiesReceived: i.emptiesReceived,
          })),
        });
        return SIN_EFECTOS;
      }

      default:
        return SIN_EFECTOS;
    }
  }

  /** URL firmada de la foto, o `null` si no hay, falla o tarda más de `FIRMA_TIMEOUT_MS`. */
  private async firmarConTimeout(key: string | null): Promise<string | null> {
    if (!key) return null;
    let timer: NodeJS.Timeout | undefined;
    const vencido = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), FIRMA_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        this.fotos.urlDe(key).catch(() => null),
        vencido,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Notifica el cambio de estado al cliente por WebSocket (best-effort). */
  private async emitStatusEvent(
    order: Order,
    status: OrderStatus,
    deliveryUser: User | null,
  ): Promise<void> {
    const eventName = STATUS_EVENT[status];
    if (!eventName) return;

    try {
      // La foto no puede demorar el aviso: si la firma tarda, sale null.
      const photoUrl = deliveryUser
        ? await this.firmarConTimeout(deliveryUser.photoKey)
        : null;
      this.dispatch.notifyCustomer(order.customerId, eventName, {
        orderId: order.orderId,
        status: order.status,
        updatedAt: new Date(),
        paymentStatus: order.paymentStatus,
        driver: deliveryUser
          ? {
              name: deliveryUser.fullName,
              phone: deliveryUser.phoneNumber,
              photoUrl,
            }
          : null,
      });
    } catch (error) {
      // Errores de WebSocket no rompen la actualización del pedido.
      this.logger.warn(
        `No se pudo emitir el evento de WebSocket "${eventName}" del pedido ${order.orderId}: ${errorMessage(error)}`,
      );
    }
  }

  /** Envía push de confirmación al cliente (best-effort). */
  private async notifyCustomer(order: Order): Promise<void> {
    // El token del cliente lo resuelve el módulo de notificaciones; si no es
    // cliente o no tiene token, no manda nada.
    try {
      await this.notificationService.sendOrderConfirmation(
        order.customerId,
        order.orderId,
      );
    } catch (error) {
      // Errores de notificación no rompen la actualización del pedido.
      this.logger.warn(
        `No se pudo enviar la notificación push de confirmación del pedido ${order.orderId}: ${errorMessage(error)}`,
      );
    }
  }
}
