import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import Decimal from 'decimal.js';

import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
} from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { User } from '../../users/entities/user.entity';
import { UserAddress } from '../../user-addres/entities/user-addres.entity';
import { CreateOrderDto } from '../dto/create-order.dto';
import { NotificationsService } from '../../notifications/notifications.service';
import { OrderPricingService } from '../domain/order-pricing.service';
import { StockReservationService } from '../domain/stock-reservation.service';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import {
  PaymentCheckoutItem,
  PaymentGatewayPort,
} from '../domain/ports/payment-gateway.port';
import { DispatchOrchestratorService } from './dispatch-orchestrator.service';
import { DistributorService } from '../../distributor/distributor.service';
import { TimeSlotService } from '../../time-slot/time-slot.service';

/** Resultado de crear un pedido: la entidad y, si es pago online, la URL de checkout. */
export interface CreateOrderResult {
  order: Order;
  paymentUrl?: string;
}

/**
 * Caso de uso: crear un pedido.
 *
 * Orquesta el flujo transaccional (reserva de stock con lock pesimista + pricing
 * de dominio + persistencia atómica) y, tras el commit, dispara el despacho en
 * tiempo real y la notificación (side-effects best-effort, no rompen el pedido).
 *
 * MERCADOPAGO es la excepción al despacho inmediato: reservamos stock y creamos
 * el pedido igual (evita oversell mientras el cliente paga), pero NO se ofrece
 * a ningún chofer hasta que el webhook confirme el pago (ver
 * ConfirmPaymentUseCase). En su lugar, se crea el checkout de Checkout Pro y se
 * devuelve la URL de pago al cliente.
 *
 * Extraído de OrderService (god object) a la capa application/. La reserva de
 * stock cruza varios agregados (garrafa + pedido) en UNA transacción, por eso el
 * manejo de la unidad de trabajo (QueryRunner) vive en el use-case y no detrás
 * del repositorio simple.
 */
@Injectable()
export class CreateOrderUseCase {
  private readonly logger = new Logger(CreateOrderUseCase.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserAddress)
    private readonly userAddressRepository: Repository<UserAddress>,
    @InjectRepository(OrderItem)
    private readonly orderItemRepository: Repository<OrderItem>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    private readonly pricing: OrderPricingService,
    private readonly stock: StockReservationService,
    private readonly dispatchOrchestrator: DispatchOrchestratorService,
    private readonly notificationService: NotificationsService,
    private readonly orders: OrderRepositoryPort,
    private readonly realtime: RealtimeDispatchPort,
    private readonly paymentGateway: PaymentGatewayPort,
    private readonly distributorService: DistributorService,
    private readonly timeSlotService: TimeSlotService,
  ) {}

  /**
   * @param distributorId Tenant al que pertenece el pedido (la distribuidora
   *   que el cliente eligió vía header X-Distributor). Todas las garrafas del
   *   pedido deben ser de esta distribuidora.
   */
  async execute(
    createOrderDto: CreateOrderDto,
    distributorId?: string | null,
  ): Promise<CreateOrderResult> {
    // Compatibilidad: sin tenant explícito (app previa al multi-tenant), el
    // pedido va a la distribuidora default.
    if (!distributorId) {
      const def = await this.distributorService.getDefault();
      distributorId = def?.distributor_id ?? null;
    }

    // Agendamiento: si el pedido trae fecha + franja, validar cupo ANTES de
    // reservar stock (falla rápido si la franja está completa). Sin fecha, es
    // entrega inmediata (comportamiento previo).
    if (createOrderDto.scheduledDate && createOrderDto.timeSlotId) {
      await this.timeSlotService.assertSlotAvailable(
        createOrderDto.timeSlotId,
        createOrderDto.scheduledDate,
        distributorId,
      );
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const customer = await this.userRepository.findOne({
        where: { user_id: createOrderDto.customerId },
        relations: ['customer'],
      });

      if (!customer || !customer.customer) {
        throw new NotFoundException('Cliente no encontrado');
      }

      const address = await this.userAddressRepository.findOne({
        where: {
          address_id: createOrderDto.addressId,
          user_id: createOrderDto.customerId,
        },
      });

      if (!address) {
        throw new NotFoundException('Dirección no encontrada');
      }

      let totalAmount = new Decimal(0);
      const orderItems: OrderItem[] = [];
      // Ítems para el checkout de MercadoPago (título legible + precio de
      // SERVIDOR). Se arman en el mismo loop para no releer las garrafas.
      const checkoutItems: PaymentCheckoutItem[] = [];

      for (const itemDto of createOrderDto.items) {
        // Reserva de stock con lock pesimista (dentro de ESTA transacción).
        // Devuelve la garrafa bloqueada para leer precio/promos de la misma fila.
        const gasCylinder = await this.stock.reserve(
          queryRunner.manager,
          itemDto.gasCylinderId,
          itemDto.quantity,
        );

        // Aislamiento multi-tenant: la garrafa debe ser de la distribuidora del
        // pedido. Impide armar un pedido mezclando catálogos de dos tenants.
        if (
          distributorId &&
          gasCylinder.distributor_id &&
          gasCylinder.distributor_id !== distributorId
        ) {
          throw new BadRequestException(
            `La garrafa ${gasCylinder.type} no pertenece a la distribuidora seleccionada`,
          );
        }

        // Pricing: precio de lista (DB, nunca del cliente) + promos por volumen.
        const { unitPrice, subtotal } = this.pricing.priceItem(
          gasCylinder.price,
          gasCylinder.promotions,
          itemDto.quantity,
        );

        totalAmount = totalAmount.plus(subtotal);

        orderItems.push(
          this.orderItemRepository.create({
            gas_cylinder_id: itemDto.gasCylinderId,
            quantity: itemDto.quantity,
            unitPrice: unitPrice.toNumber(),
            subtotal: subtotal.toNumber(),
          }),
        );

        checkoutItems.push({
          id: itemDto.gasCylinderId,
          title: `Garrafa ${gasCylinder.type}`,
          quantity: itemDto.quantity,
          unitPrice: unitPrice.toNumber(),
        });
      }

      // Recargo por método de pago (dominio): +10% si es TRANSFER.
      totalAmount = this.pricing.applyPaymentSurcharge(
        totalAmount,
        createOrderDto.paymentMethod,
      );

      const paymentType =
        createOrderDto.paymentMethod === PaymentMethod.CASH
          ? PaymentType.CASH
          : PaymentType.ONLINE;

      const order = this.orderRepository.create({
        customer_id: createOrderDto.customerId,
        distributor_id: distributorId ?? undefined,
        address_id: createOrderDto.addressId,
        status: OrderStatus.PENDING,
        paymentMethod: createOrderDto.paymentMethod,
        paymentType,
        time_slot_id: createOrderDto.timeSlotId,
        paymentStatus: PaymentStatus.PENDING,
        totalAmount: totalAmount.toNumber(),
        scheduled_date: createOrderDto.scheduledDate ?? null,
        notes: createOrderDto.notes,
        deliveryLatitude: address.latitude,
        deliveryLongitude: address.longitude,
        items: orderItems,
      });

      const savedOrder = await queryRunner.manager.save(order);
      await queryRunner.commitTransaction();

      // Side-effects post-commit: best-effort, nunca rompen la creación del pedido.
      let paymentUrl: string | undefined;

      if (createOrderDto.paymentMethod === PaymentMethod.MERCADOPAGO) {
        // Pago online: NO se despacha todavía. El pedido queda PENDING/PENDING
        // (status/paymentStatus) hasta que el webhook de MercadoPago confirme el
        // pago (ConfirmPaymentUseCase), recién ahí se ofrece a un chofer.
        paymentUrl = await this.createMercadoPagoCheckout(
          savedOrder,
          checkoutItems,
          customer,
        );
      } else {
        // Despacho SECUENCIAL: ofrece al chofer más cercano con timeout de 30s; el
        // cron re-ofrece al siguiente si no responde.
        await this.dispatchOrchestrator
          .offerToNextDriver(savedOrder)
          .catch(() => undefined);
      }

      await this.sendConfirmation(savedOrder.order_id, createOrderDto);

      // Panel admin en vivo: nuevo pedido.
      this.realtime.notifyAdmins('order:created', {
        orderId: savedOrder.order_id,
        distributorId: savedOrder.distributor_id,
        totalAmount: savedOrder.totalAmount,
        status: savedOrder.status,
        paymentMethod: savedOrder.paymentMethod,
      });

      const result = await this.orders.findByIdFull(savedOrder.order_id);
      if (!result) {
        throw new InternalServerErrorException(
          'Pedido creado pero no recuperable',
        );
      }
      return { order: result, paymentUrl };
    } catch (error: any) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      if (error.status === 404 || error.status === 400) {
        throw error;
      }
      this.logger.error(`create order falló: ${error?.message}`);
      throw new InternalServerErrorException('Error al crear el pedido');
    } finally {
      await queryRunner.release();
    }
  }

  private async sendConfirmation(
    orderId: string,
    dto: CreateOrderDto,
  ): Promise<void> {
    try {
      await this.notificationService.sendOrderConfirmation(
        dto.customerId,
        orderId,
        dto.notificationToken,
      );
    } catch {
      // Ignorar errores de notificación.
    }
  }

  /**
   * Crea la preferencia de Checkout Pro para un pedido MERCADOPAGO ya
   * persistido. Best-effort: si la pasarela falla, el pedido queda creado
   * igual (stock ya reservado) pero sin `paymentUrl` — el cliente puede
   * reintentar el pago más tarde.
   * TODO: endpoint para regenerar el checkout de un pedido MP pendiente sin
   * `gatewayPaymentId` (evita que quede "colgado" si MP estuvo caído).
   */
  private async createMercadoPagoCheckout(
    savedOrder: Order,
    checkoutItems: PaymentCheckoutItem[],
    customer: User,
  ): Promise<string | undefined> {
    try {
      const checkout = await this.paymentGateway.createCheckout({
        orderId: savedOrder.order_id,
        items: checkoutItems,
        payerEmail: customer.email || '',
      });
      return checkout.initPoint;
    } catch (error: any) {
      this.logger.error(
        `No se pudo crear el checkout de MercadoPago para ${savedOrder.order_id}: ${error?.message}`,
      );
      return undefined;
    }
  }
}
