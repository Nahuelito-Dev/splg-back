import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';

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
import { generateDeliveryCode } from '../domain/delivery-code.util';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import { CylinderLifecyclePort } from '../domain/ports/cylinder-lifecycle.port';
import { DispatchOrchestratorService } from './dispatch-orchestrator.service';
import { RoleType } from '../../common/constants/role-type.enum';
import { errorMessage } from '../../common/errors/error-message';

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
    private readonly deliveries: DeliveryService,
    private readonly dispatch: RealtimeDispatchPort,
    private readonly notificationService: NotificationPort,
    private readonly orders: OrderRepositoryPort,
    private readonly dispatchOrchestrator: DispatchOrchestratorService,
    private readonly cylinderLifecycle: CylinderLifecyclePort,
  ) {}

  async execute(
    id: string,
    status: OrderStatus,
    deliveryId?: string,
    role?: RoleType,
  ): Promise<Order> {
    const order = await this.orders.findByIdFull(id);
    if (!order) throw new NotFoundException(`Order with ID: ${id} not found`);

    // Antes de tocar nada: el pedido tiene que ser de quien lo está moviendo.
    await this.assertPedidoDelChofer(order, deliveryId, role);

    // Dominio: valida que la transición sea legal (PENDING→ACCEPTED→ON_THE_WAY
    // →DELIVERED) y la aplica. Rechaza saltos/estados terminales con 400.
    transitionOrder(order, status);
    const deliveryUser = await this.applyStatusEffects(
      order,
      status,
      deliveryId,
    );

    await this.orders.save(order);

    this.emitStatusEvent(order, status, deliveryUser);
    // Panel admin en vivo: los valores del enum (accepted/on_the_way/delivered)
    // coinciden con los eventos que escucha la campana del panel.
    this.dispatch.notifyAdmins(`order:${status}`, {
      orderId: order.orderId,
      status: order.status,
      totalAmount: order.totalAmount,
    });
    await this.notifyCustomer(order);

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
    deliveryId?: string,
  ): Promise<User | null> {
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
        if (!delivery.isActive) {
          throw new BadRequestException('El repartidor no está activo');
        }

        order.deliveryId = delivery.deliveryId;
        order.acceptedAt = new Date();
        // Prueba de entrega con QR: se genera acá el código secreto que el
        // chofer mostrará en su QR y el cliente escaneará para confirmar la
        // entrega (ver ConfirmDeliveryUseCase). Ya queda listo para cuando el
        // pedido pase a ON_THE_WAY.
        order.deliveryCode = generateDeliveryCode();

        // Cierra la oferta de despacho como ACCEPTED (best-effort, audit). El
        // offer.driver_id es el user_id, el mismo que usa el GEO/WS.
        await this.dispatchOrchestrator
          .onDriverAccepted(order.orderId, delivery.userId)
          .catch(() => undefined);

        return delivery.user;
      }

      case OrderStatus.ON_THE_WAY: {
        order.onTheWayAt = new Date();
        if (!order.deliveryId) return null;
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
          );
        }
        return existingDelivery?.user ?? null;
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
        // WITH_CUSTOMER. Best-effort: si falla (o la distribuidora no usa
        // envases, en cuyo caso es no-op) NO rompe la entrega del pedido.
        try {
          const advanced = await this.cylinderLifecycle.onOrderDelivered(
            order.orderId,
            order.distributorId,
          );
          if (advanced > 0) {
            this.logger.log(
              `Pedido ${order.orderId} entregado: ${advanced} envase(s) → with_customer`,
            );
          }
        } catch (err) {
          this.logger.warn(
            `No se pudieron avanzar los envases del pedido ${order.orderId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        return null;
      }

      default:
        return null;
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
