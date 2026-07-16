import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../entities/order.entity';
import { User } from '../../users/entities/user.entity';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { NotificationsService } from '../../notifications/notifications.service';
import { transitionOrder } from '../domain/order-status.machine';
import { generateDeliveryCode } from '../domain/delivery-code.util';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import { CylinderLifecyclePort } from '../domain/ports/cylinder-lifecycle.port';
import { DispatchOrchestratorService } from './dispatch-orchestrator.service';

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
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Delivery)
    private readonly deliveryRepository: Repository<Delivery>,
    private readonly dispatch: RealtimeDispatchPort,
    private readonly notificationService: NotificationsService,
    private readonly orders: OrderRepositoryPort,
    private readonly dispatchOrchestrator: DispatchOrchestratorService,
    private readonly cylinderLifecycle: CylinderLifecyclePort,
  ) {}

  async execute(
    id: string,
    status: OrderStatus,
    deliveryId?: string,
  ): Promise<Order> {
    const order = await this.orders.findByIdFull(id);
    if (!order) throw new NotFoundException(`Order with ID: ${id} not found`);

    // Dominio: valida que la transición sea legal (PENDING→ACCEPTED→ON_THE_WAY
    // →DELIVERED) y la aplica. Rechaza saltos/estados terminales con 400.
    transitionOrder(order, status);
    const deliveryUser = await this.applyStatusEffects(order, status, deliveryId);

    await this.orders.save(order);

    this.emitStatusEvent(order, status, deliveryUser);
    // Panel admin en vivo: los valores del enum (accepted/on_the_way/delivered)
    // coinciden con los eventos que escucha la campana del panel.
    this.dispatch.notifyAdmins(`order:${status}`, {
      orderId: order.order_id,
      status: order.status,
      totalAmount: order.totalAmount,
    });
    await this.notifyCustomer(order);

    return order;
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

        const delivery = await this.deliveryRepository.findOne({
          where: [{ delivery_id: deliveryId }, { user_id: deliveryId }],
          relations: ['user'],
        });

        if (!delivery) {
          throw new NotFoundException(
            `Repartidor no encontrado con ID: ${deliveryId}`,
          );
        }
        if (!delivery.isActive) {
          throw new BadRequestException('El repartidor no está activo');
        }

        order.delivery_id = delivery.delivery_id;
        order.acceptedAt = new Date();
        // Prueba de entrega con QR: se genera acá el código secreto que el
        // chofer mostrará en su QR y el cliente escaneará para confirmar la
        // entrega (ver ConfirmDeliveryUseCase). Ya queda listo para cuando el
        // pedido pase a ON_THE_WAY.
        order.deliveryCode = generateDeliveryCode();

        // Cierra la oferta de despacho como ACCEPTED (best-effort, audit). El
        // offer.driver_id es el user_id, el mismo que usa el GEO/WS.
        await this.dispatchOrchestrator
          .onDriverAccepted(order.order_id, delivery.user_id)
          .catch(() => undefined);

        return delivery.user;
      }

      case OrderStatus.ON_THE_WAY: {
        order.onTheWayAt = new Date();
        if (!order.delivery_id) return null;
        const existingDelivery = await this.deliveryRepository.findOne({
          where: { delivery_id: order.delivery_id },
          relations: ['user'],
        });
        // Activa el tracking en vivo: el GPS de este chofer se reenviará al
        // cliente mientras esté en camino.
        if (existingDelivery?.user) {
          this.dispatch.startTracking(
            existingDelivery.user.user_id,
            order.order_id,
            order.customer_id,
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
        if (order.delivery_id) {
          const del = await this.deliveryRepository.findOne({
            where: { delivery_id: order.delivery_id },
            relations: ['user'],
          });
          if (del?.user) this.dispatch.stopTracking(del.user.user_id);
        }
        // Ciclo del envase: avanza los envases despachados en este pedido a
        // WITH_CUSTOMER. Best-effort: si falla (o la distribuidora no usa
        // envases, en cuyo caso es no-op) NO rompe la entrega del pedido.
        try {
          const advanced = await this.cylinderLifecycle.onOrderDelivered(
            order.order_id,
            order.distributor_id,
          );
          if (advanced > 0) {
            this.logger.log(
              `Pedido ${order.order_id} entregado: ${advanced} envase(s) → with_customer`,
            );
          }
        } catch (err) {
          this.logger.warn(
            `No se pudieron avanzar los envases del pedido ${order.order_id}: ${
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
      this.dispatch.notifyCustomer(order.customer_id, eventName, {
        orderId: order.order_id,
        status: order.status,
        updatedAt: new Date(),
        paymentStatus: order.paymentStatus,
        driver: deliveryUser
          ? {
              name: deliveryUser.full_name,
              phone: deliveryUser.phone_number,
            }
          : null,
      });
    } catch (error) {
      // Errores de WebSocket no rompen la actualización del pedido.
      this.logger.warn(
        `No se pudo emitir el evento de WebSocket "${eventName}" del pedido ${order.order_id}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /** Envía push de confirmación al cliente (best-effort). */
  private async notifyCustomer(order: Order): Promise<void> {
    const customer = await this.userRepository.findOne({
      where: { user_id: order.customer_id },
      relations: ['customer'],
    });
    if (!customer?.customer) return;

    try {
      await this.notificationService.sendOrderConfirmation(
        order.customer_id,
        order.order_id,
        customer.customer.notification_token,
      );
    } catch (error) {
      // Errores de notificación no rompen la actualización del pedido.
      this.logger.warn(
        `No se pudo enviar la notificación push de confirmación del pedido ${order.order_id}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
