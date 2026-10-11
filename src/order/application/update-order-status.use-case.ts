import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';

import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../entities/order.entity';
import { User } from '../../users/entities/user.entity';
import { DeliveryService } from '../../delivery/delivery.service';
import { NotificationPort } from '../domain/ports/notification.port';
import { transitionOrder } from '../domain/order-status.machine';
import { assertReservaActivable } from '../domain/reservation-activation';
import { generateDeliveryCode } from '../domain/delivery-code.util';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import { CylinderLifecyclePort } from '../domain/ports/cylinder-lifecycle.port';
import { StockDeliveryPort } from '../domain/ports/stock-delivery.port';
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

/** Resultado de aplicar los efectos de un estado dentro de la transacción. */
interface EfectosDelEstado {
  deliveryUser: User | null;
  /** `user_id` del chofer que aceptó, para cerrar su oferta tras el commit. */
  aceptacionDelChoferUserId: string | null;
}

const SIN_EFECTOS: EfectosDelEstado = {
  deliveryUser: null,
  aceptacionDelChoferUserId: null,
};

/** Evento de tiempo real emitido al cliente por cada estado del pedido. */
const STATUS_EVENT: Partial<Record<OrderStatus, string>> = {
  [OrderStatus.ACCEPTED]: 'order:accepted',
  [OrderStatus.ON_THE_WAY]: 'order:on-the-way',
  [OrderStatus.DELIVERED]: 'order:delivered',
  [OrderStatus.CANCELLED]: 'order:cancelled',
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
  ) {}

  async execute(
    id: string,
    status: OrderStatus,
    deliveryId?: string,
    role?: RoleType,
    actorUserId?: string,
  ): Promise<Order> {
    // La entrega es la prueba de que el cliente recibió el pedido: se confirma
    // con el QR del chofer (`ConfirmDeliveryUseCase`, que llega acá SIN rol) o
    // la cierra un administrador. El chofer no puede cerrarla por su cuenta.
    if (status === OrderStatus.DELIVERED && role === RoleType.DELIVERY) {
      throw new ForbiddenException(
        'La entrega se confirma con el QR del cliente',
      );
    }

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
    try {
      const locked = await queryRunner.manager
        .createQueryBuilder(Order, 'ord')
        .setLock('pessimistic_write', undefined, ['ord'])
        .leftJoinAndSelect('ord.delivery', 'delivery')
        .leftJoinAndSelect('ord.items', 'items')
        .where('ord.orderId = :id', { id })
        .getOne();

      if (!locked) {
        throw new NotFoundException(`Order with ID: ${id} not found`);
      }

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
      );
      deliveryUser = efectos.deliveryUser;
      aceptacionADespachar = efectos.aceptacionDelChoferUserId;

      order = await queryRunner.manager.save(locked);
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

    this.emitStatusEvent(order, status, deliveryUser);
    // Panel admin en vivo: los valores del enum (accepted/on_the_way/delivered)
    // coinciden con los eventos que escucha la campana del panel. Sólo a los
    // admins DE ESA distribuidora (+ super admin, que ven todas).
    const adminPayload = {
      orderId: order.orderId,
      status: order.status,
      totalAmount: order.totalAmount,
    };
    this.dispatch.notifyAdmins(
      `order:${status}`,
      adminPayload,
      order.distributorId,
    );
    // H-54: el namespace del cliente emite `order:on-the-way` (con guión)
    // para este estado; el panel usaba el valor crudo del enum,
    // `order:on_the_way` (guión bajo), medido contra sockets reales el
    // 26/09. Unificamos en el nombre con guión y dejamos el de arriba como
    // ALIAS de compatibilidad para paneles que todavía no migraron.
    if (status === OrderStatus.ON_THE_WAY) {
      this.dispatch.notifyAdmins(
        'order:on-the-way',
        adminPayload,
        order.distributorId,
      );
    }
    await this.notifyCustomer(order);

    return order;
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
    if (!order) throw new NotFoundException(`Order with ID: ${id} not found`);

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
        .leftJoinAndSelect('ord.items', 'items')
        .where('ord.orderId = :id', { id })
        .getOne();

      if (!locked) {
        throw new NotFoundException(`Order with ID: ${id} not found`);
      }

      yaActivada = locked.status !== OrderStatus.RESERVED;
      if (!yaActivada) {
        assertReservaActivable(locked);
        transitionOrder(locked, OrderStatus.PENDING);
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
  ): Promise<EfectosDelEstado> {
    switch (status) {
      case OrderStatus.ACCEPTED: {
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
          throw new NotFoundException(
            `Repartidor no encontrado con ID: ${deliveryId}`,
          );
        }
        // Mismo gate que la asignación manual (`assignDelivery`): habilitado
        // y validado. No exige que esté en línea.
        this.deliveries.assertElegibleParaAsignacion(delivery);
        // Con el chofer bloqueado (el mismo lock que `ponerEnUso`, la baja y
        // la asignación a mano): el vehículo que se lee abajo no cambia hasta
        // el commit, y una baja que ganó la carrera se ve acá.
        if (!(await bloquearChoferVigente(manager, delivery.deliveryId))) {
          throw new NotFoundException(
            `Repartidor no encontrado con ID: ${deliveryId}`,
          );
        }
        // Y el mismo gate de flota (CU-136 a CU-138): la licencia propia o el
        // vehículo que maneja no pueden tener un documento bloqueante vencido.
        // Se aplica tanto si acepta el admin (con `deliveryId`) como si acepta
        // el propio chofer desde el pool (`GET /orders/available`).
        await this.fleetGate.assertChoferHabilitado(
          delivery.userId,
          order.distributorId,
        );
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
          order.acceptedAt = new Date();
          // Prueba de entrega con QR: se genera acá el código secreto que el
          // chofer mostrará en su QR y el cliente escaneará para confirmar la
          // entrega (ver ConfirmDeliveryUseCase). Ya queda listo para cuando
          // el pedido pase a ON_THE_WAY.
          order.deliveryCode = generateDeliveryCode();

          // La oferta de despacho se cierra como ACCEPTED después del commit
          // (el offer.driver_id es el user_id, el mismo que usa el GEO/WS).
          aceptacionDelChoferUserId = delivery.userId;
        }

        return {
          deliveryUser: delivery.user,
          aceptacionDelChoferUserId,
        };
      }

      case OrderStatus.ON_THE_WAY: {
        order.onTheWayAt = new Date();
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
        };
      }

      case OrderStatus.DELIVERED: {
        order.deliveredAt = new Date();
        if (order.paymentMethod === PaymentMethod.CASH) {
          order.paymentStatus = PaymentStatus.PAID;
        }
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
          })),
        });
        return SIN_EFECTOS;
      }

      default:
        return SIN_EFECTOS;
    }
  }

  /** Notifica el cambio de estado al cliente por WebSocket (best-effort). */
  private emitStatusEvent(
    order: Order,
    status: OrderStatus,
    deliveryUser: User | null,
  ): void {
    const eventName = STATUS_EVENT[status];
    if (!eventName) return;

    try {
      this.dispatch.notifyCustomer(order.customerId, eventName, {
        orderId: order.orderId,
        status: order.status,
        updatedAt: new Date(),
        paymentStatus: order.paymentStatus,
        driver: deliveryUser
          ? {
              name: deliveryUser.fullName,
              phone: deliveryUser.phoneNumber,
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
