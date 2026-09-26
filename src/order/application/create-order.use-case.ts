import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  HttpException,
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
import { CustomersService } from '../../customer/customer.service';
import { UserAddressService } from '../../user-address/user-address.service';
import { CreateOrderDto } from '../dto/create-order.dto';
import { NotificationPort } from '../domain/ports/notification.port';
import { OrderPricingService } from '../domain/order-pricing.service';
import { CoverageZoneService } from '../../coverage-zone/coverage-zone.service';
import { GasCylinderService } from '../../gascylinder/gascylinder.service';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import { PaymentCheckoutItem } from '../../payments/domain/ports/payment-gateway.port';
import { PaymentsService } from '../../payments/application/payments.service';
import { DispatchOrchestratorService } from './dispatch-orchestrator.service';
import { DistributorService } from '../../distributor/distributor.service';
import { TimeSlotService } from '../../time-slot/time-slot.service';
import { errorMessage } from '../../common/errors/error-message';
import { coordenadasDePunto } from '../../common/geo/punto';
import { DomainError } from '../../common/errors/domain.error';

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
    private readonly customers: CustomersService,
    private readonly addresses: UserAddressService,
    @InjectRepository(OrderItem)
    private readonly orderItemRepository: Repository<OrderItem>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    private readonly pricing: OrderPricingService,
    private readonly stock: GasCylinderService,
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
      distributorId = def?.distributorId ?? null;
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
      const customer = await this.customers.buscarComprador(
        createOrderDto.customerId,
      );
      if (!customer) {
        throw new NotFoundException('Cliente no encontrado');
      }

      const address = await this.addresses.buscarDelUsuario(
        createOrderDto.addressId,
        createOrderDto.customerId,
      );

      if (!address) {
        throw new NotFoundException('Dirección no encontrada');
      }

      // Zona de cobertura: si la distribuidora definió zonas (PostGIS), la
      // dirección debe caer dentro de alguna → si no, se rechaza el pedido
      // ANTES de reservar stock. La zona puede además tener un recargo (delivery
      // por lejanía) que se suma al total. Si la distribuidora NO definió zonas,
      // checkCoverage devuelve covered:true / surcharge:0 (no-op).
      let zoneSurcharge = new Decimal(0);
      const punto = coordenadasDePunto(address.location);
      if (distributorId && punto) {
        const coverage = await this.coverageZoneService.checkCoverage(
          distributorId,
          punto.lat,
          punto.lng,
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
        const gasCylinder = await this.stock.reservarStock(
          queryRunner.manager,
          itemDto.gasCylinderId,
          itemDto.quantity,
        );

        // Aislamiento multi-tenant: la garrafa debe pertenecer EXACTAMENTE a la
        // distribuidora del pedido. Rechaza tanto una garrafa de otro tenant
        // como una con `distributor_id` null (dato sin backfillear), que antes
        // se colaba en cualquier tenant.
        if (distributorId && gasCylinder.distributorId !== distributorId) {
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
            gasCylinderId: itemDto.gasCylinderId,
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
        customerId: createOrderDto.customerId,
        distributorId: distributorId ?? undefined,
        addressId: createOrderDto.addressId,
        status: isReservation ? OrderStatus.RESERVED : OrderStatus.PENDING,
        paymentMethod: createOrderDto.paymentMethod,
        paymentType,
        timeSlotId: createOrderDto.timeSlotId,
        paymentStatus: PaymentStatus.PENDING,
        totalAmount: totalAmount.toNumber(),
        depositAmount,
        depositPaid: false,
        scheduledDate: createOrderDto.scheduledDate ?? null,
        notes: createOrderDto.notes,
        deliveryPoint: address.location ?? null,
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

      await this.sendConfirmation(savedOrder.orderId, createOrderDto);

      // Panel admin en vivo: nuevo pedido.
      this.realtime.notifyAdmins('order:created', {
        orderId: savedOrder.orderId,
        distributorId: savedOrder.distributorId,
        totalAmount: savedOrder.totalAmount,
        status: savedOrder.status,
        paymentMethod: savedOrder.paymentMethod,
      });

      const result = await this.orders.findByIdFull(savedOrder.orderId);
      if (!result) {
        throw new InternalServerErrorException(
          'Pedido creado pero no recuperable',
        );
      }
      return { order: result, paymentUrl };
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      // Los errores de quien pide (validación, stock, cobertura, pertenencia)
      // se devuelven tal cual. Antes sólo pasaban los que traían `status` 400 o
      // 404: los de dominio no lo traen, y "sin stock" salía como 500 (H-85).
      if (
        error instanceof DomainError ||
        (error instanceof HttpException && error.getStatus() < 500)
      ) {
        throw error;
      }
      this.logger.error(`create order falló: ${errorMessage(error)}`);
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
        `No se pudo enviar la notificación de confirmación del pedido ${orderId}: ${errorMessage(error)}`,
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
    customer: { email: string | null },
  ): Promise<string | undefined> {
    try {
      const checkout = await this.paymentsService.createCheckout({
        orderId: savedOrder.orderId,
        distributorId: savedOrder.distributorId ?? null,
        amount: savedOrder.totalAmount,
        isDeposit: false,
        items: checkoutItems,
        payerEmail: customer.email || '',
      });
      return checkout.initPoint;
    } catch (error) {
      this.logger.error(
        `No se pudo crear el checkout de MercadoPago para ${savedOrder.orderId}: ${errorMessage(error)}`,
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
    customer: { email: string | null },
  ): Promise<string | undefined> {
    try {
      const checkout = await this.paymentsService.createCheckout({
        orderId: savedOrder.orderId,
        distributorId: savedOrder.distributorId ?? null,
        amount: depositAmount,
        isDeposit: true,
        items: [
          {
            id: `deposit-${savedOrder.orderId}`,
            title: 'Seña de reserva',
            quantity: 1,
            unitPrice: depositAmount,
          },
        ],
        payerEmail: customer.email || '',
      });
      return checkout.initPoint;
    } catch (error) {
      this.logger.error(
        `No se pudo crear el checkout de la seña para ${savedOrder.orderId}: ${errorMessage(error)}`,
      );
      return undefined;
    }
  }
}
