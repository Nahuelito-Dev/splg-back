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
import { NotificationPort } from '../domain/ports/notification.port';
import { OrderPricingService } from '../domain/order-pricing.service';
import { CoverageZoneService } from '../../coverage-zone/coverage-zone.service';
import { StockReservationService } from '../domain/stock-reservation.service';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import { PaymentCheckoutItem } from '../../payments/domain/ports/payment-gateway.port';
import { PaymentsService } from '../../payments/application/payments.service';
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
    private readonly notificationService: NotificationPort,
    private readonly orders: OrderRepositoryPort,
    private readonly realtime: RealtimeDispatchPort,
    private readonly paymentsService: PaymentsService,
    private readonly distributorService: DistributorService,
    private readonly timeSlotService: TimeSlotService,
    private readonly coverageZoneService: CoverageZoneService,
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

    // Pre-reserva: requiere fecha agendada (se reserva PARA un día futuro).
    if (createOrderDto.isReservation && !createOrderDto.scheduledDate) {
      throw new BadRequestException(
        'Una reserva requiere scheduledDate (fecha de entrega agendada)',
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

      // Zona de cobertura: si la distribuidora definió zonas (PostGIS), la
      // dirección debe caer dentro de alguna → si no, se rechaza el pedido
      // ANTES de reservar stock. La zona puede además tener un recargo (delivery
      // por lejanía) que se suma al total. Si la distribuidora NO definió zonas,
      // checkCoverage devuelve covered:true / surcharge:0 (no-op).
      let zoneSurcharge = new Decimal(0);
      if (distributorId) {
        const coverage = await this.coverageZoneService.checkCoverage(
          distributorId,
          Number(address.latitude),
          Number(address.longitude),
        );
        if (!coverage.covered) {
          throw new BadRequestException(
            'La dirección está fuera de la zona de cobertura de la distribuidora',
          );
        }
        zoneSurcharge = new Decimal(coverage.surcharge ?? 0);
      }

      // Agendamiento: validar cupo de la franja DENTRO de la transacción y con
      // lock pesimista sobre la franja, para que reservas concurrentes no
      // superen la capacidad (antes corría fuera de la tx y sin lock = race).
      if (createOrderDto.scheduledDate && createOrderDto.timeSlotId) {
        await this.timeSlotService.assertSlotAvailableTx(
          queryRunner.manager,
          createOrderDto.timeSlotId,
          createOrderDto.scheduledDate,
          distributorId,
        );
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

        // Aislamiento multi-tenant: la garrafa debe pertenecer EXACTAMENTE a la
        // distribuidora del pedido. Rechaza tanto una garrafa de otro tenant
        // como una con `distributor_id` null (dato sin backfillear), que antes
        // se colaba en cualquier tenant.
        if (
          distributorId &&
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

      // Recargo por zona de cobertura (delivery por lejanía), sobre el subtotal
      // de los ítems, antes del recargo por método de pago.
      totalAmount = totalAmount.plus(zoneSurcharge);

      // Recargo por método de pago (dominio): +10% en pagos online (MP/Transfer).
      totalAmount = this.pricing.applyPaymentSurcharge(
        totalAmount,
        createOrderDto.paymentMethod,
      );

      const paymentType =
        createOrderDto.paymentMethod === PaymentMethod.CASH
          ? PaymentType.CASH
          : PaymentType.ONLINE;

      // Pre-reserva: nace RESERVED (no se despacha) con su seña; el resto nace
      // PENDING como siempre.
      const isReservation = !!createOrderDto.isReservation;
      const depositAmount = isReservation
        ? (createOrderDto.depositAmount ?? 0)
        : 0;

      const order = this.orderRepository.create({
        customer_id: createOrderDto.customerId,
        distributor_id: distributorId ?? undefined,
        address_id: createOrderDto.addressId,
        status: isReservation ? OrderStatus.RESERVED : OrderStatus.PENDING,
        paymentMethod: createOrderDto.paymentMethod,
        paymentType,
        time_slot_id: createOrderDto.timeSlotId,
        paymentStatus: PaymentStatus.PENDING,
        totalAmount: totalAmount.toNumber(),
        deposit_amount: depositAmount,
        deposit_paid: false,
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

      if (isReservation) {
        // Pre-reserva: NO se despacha (lo hará el cron el día agendado con la
        // seña paga). Si la seña es por MP, se crea un checkout SOLO por el
        // monto de la seña; el webhook marcará deposit_paid.
        if (
          createOrderDto.paymentMethod === PaymentMethod.MERCADOPAGO &&
          depositAmount > 0
        ) {
          paymentUrl = await this.createDepositCheckout(
            savedOrder,
            depositAmount,
            customer,
          );
        }
        // Seña en efectivo: queda deposit_paid=false hasta que el admin la
        // confirme (ReservationService.confirmDeposit).
      } else if (createOrderDto.paymentMethod === PaymentMethod.MERCADOPAGO) {
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
    } catch (error) {
      // Best-effort: errores de notificación no rompen la creación del pedido.
      this.logger.warn(
        `No se pudo enviar la notificación de confirmación del pedido ${orderId}: ${error instanceof Error ? error.message : error}`,
      );
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
      const checkout = await this.paymentsService.createCheckout({
        orderId: savedOrder.order_id,
        distributorId: savedOrder.distributor_id ?? null,
        amount: savedOrder.totalAmount,
        isDeposit: false,
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

  /**
   * Checkout de Checkout Pro SOLO por la seña de una reserva. El webhook, al
   * aprobarse, marca `deposit_paid` en vez de despachar (ver ConfirmPaymentUseCase).
   */
  private async createDepositCheckout(
    savedOrder: Order,
    depositAmount: number,
    customer: User,
  ): Promise<string | undefined> {
    try {
      const checkout = await this.paymentsService.createCheckout({
        orderId: savedOrder.order_id,
        distributorId: savedOrder.distributor_id ?? null,
        amount: depositAmount,
        isDeposit: true,
        items: [
          {
            id: `deposit-${savedOrder.order_id}`,
            title: 'Seña de reserva',
            quantity: 1,
            unitPrice: depositAmount,
          },
        ],
        payerEmail: customer.email || '',
      });
      return checkout.initPoint;
    } catch (error: any) {
      this.logger.error(
        `No se pudo crear el checkout de la seña para ${savedOrder.order_id}: ${error?.message}`,
      );
      return undefined;
    }
  }
}
