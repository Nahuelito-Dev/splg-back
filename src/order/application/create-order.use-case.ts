import { bloquearCuentaParaPedido } from '../../common/locks/cuenta-lock';
import { marcarRespuestaIncompleta } from '../../common/interceptors/respuesta-incompleta';
import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  HttpException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import type { Point } from 'typeorm';
import type { GasCylinder } from '../../gascylinder/entities/gascylinder.entity';
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
import {
  CoverageZonePricingService,
  ZonaParaRecargo,
} from '../../coverage-zone/coverage-zone-pricing.service';
import type { CoverageZoneResumenDto } from '../../coverage-zone/dto/coverage-zone-response.dto';
import { GasCylinderService } from '../../gascylinder/gascylinder.service';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import { PaymentCheckoutItem } from '../../payments/domain/ports/payment-gateway.port';
import { PaymentsService } from '../../payments/application/payments.service';
import { DispatchOrchestratorService } from './dispatch-orchestrator.service';
import { DistributorService } from '../../distributor/distributor.service';
import { TimeSlotService } from '../../time-slot/time-slot.service';
import { errorCode, errorMessage } from '../../common/errors/error-message';
import { coordenadasDePunto } from '../../common/geo/punto';
import { DomainError } from '../../common/errors/domain.error';
import { esTimeoutDeBase } from '../../common/errors/db-exceptions';

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
    private readonly coverageZonePricing: CoverageZonePricingService,
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
      // Primer lock de la transacción (ver `cuenta-lock`): una baja de la
      // cuenta del cliente en curso termina antes, y el pedido no cuelga de
      // una cuenta dada de baja.
      const cuentaVigente = await bloquearCuentaParaPedido(
        queryRunner.manager,
        createOrderDto.customerId,
      );
      if (!cuentaVigente) {
        throw new NotFoundException('Cliente no encontrado');
      }

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

      // Zona de cobertura: ver `resolverZona` (rechaza ANTES de reservar stock).
      const coverageZone = await this.resolverZona(distributorId, address);

      // Agendamiento: validar cupo de la franja DENTRO de la transacción y con
      // lock pesimista sobre la franja, para que reservas concurrentes no
      // superen la capacidad (antes corría fuera de la tx y sin lock = race).
      if (createOrderDto.timeSlotId && !createOrderDto.scheduledDate) {
        await this.timeSlotService.assertSlotUsableTx(
          queryRunner.manager,
          createOrderDto.timeSlotId,
          distributorId,
        );
      }
      if (createOrderDto.scheduledDate && createOrderDto.timeSlotId) {
        await this.timeSlotService.assertSlotAvailableTx(
          queryRunner.manager,
          createOrderDto.timeSlotId,
          createOrderDto.scheduledDate,
          distributorId,
        );
      }

      // Reserva de stock con lock + precios de servidor (ver `reservarRenglones`).
      const { orderItems, checkoutItems, subtotalItems } =
        await this.reservarRenglones(
          queryRunner.manager,
          createOrderDto.items,
          distributorId,
        );

      // Recargos de zona y de método de pago (ver `calcularTotales`).
      const { totalAmount, zoneSurchargeAmount } = this.calcularTotales(
        subtotalItems,
        coverageZone,
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
        // Snapshot de la zona de cobertura al momento de pedir: el total
        // tiene que poder reconstruirse aunque la zona se edite o se borre.
        coverageZoneId: coverageZone?.id ?? null,
        zoneName: coverageZone?.name ?? null,
        zoneSurchargeType: coverageZone?.type ?? null,
        zoneSurchargeValue: coverageZone?.value ?? null,
        zoneSurchargeAmount: zoneSurchargeAmount.toNumber(),
        subtotalItems: subtotalItems.toNumber(),
      });

      const savedOrder = await queryRunner.manager.save(order);
      await queryRunner.commitTransaction();

      // Desde acá el pedido YA está confirmado: nada de lo que sigue puede
      // tirar el request (un 500 con el pedido creado haría que el reintento
      // con la misma Idempotency-Key creara otro).
      return await this.despuesDelCommit(
        savedOrder,
        createOrderDto,
        isReservation,
        depositAmount,
        customer,
        checkoutItems,
      );
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      // Los errores de quien pide (validación, stock, cobertura, pertenencia)
      // se devuelven tal cual. Antes sólo pasaban los que traían `status` 400 o
      // 404: los de dominio no lo traen, y "sin stock" salía como 500 (H-85).
      // Deadlock o fallo de serialización: se deja pasar tal cual para que
      // `withTransactionRetry` (en el controller) reintente; si se agotan los
      // intentos sale 409, no 500.
      if (['40P01', '40001'].includes(errorCode(error) ?? '')) {
        throw error;
      }
      // Timeout de lock/consulta: no se reintenta (cada intento esperaría el
      // timeout completo y la respuesta pasaría el del interceptor); el filtro
      // global lo traduce a 503.
      if (esTimeoutDeBase(error)) {
        throw error;
      }
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

  /**
   * Efectos posteriores al commit (checkout, despacho, aviso, panel) y relectura
   * del pedido. Best-effort: el pedido ya existe, así que ninguna falla de
   * acá puede devolver un error al cliente.
   */
  private async despuesDelCommit(
    savedOrder: Order,
    createOrderDto: CreateOrderDto,
    isReservation: boolean,
    depositAmount: number,
    customer: { email: string | null },
    checkoutItems: PaymentCheckoutItem[],
  ): Promise<CreateOrderResult> {
    let paymentUrl: string | undefined;
    try {
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

      // Panel admin en vivo: nuevo pedido. Sólo a los admins DE ESA
      // distribuidora (+ super admin, que ven todas).
      this.realtime.notifyAdmins(
        'order:created',
        {
          orderId: savedOrder.orderId,
          distributorId: savedOrder.distributorId,
          totalAmount: savedOrder.totalAmount,
          status: savedOrder.status,
          paymentMethod: savedOrder.paymentMethod,
        },
        savedOrder.distributorId,
      );
    } catch (error) {
      this.logger.error(
        `Pedido ${savedOrder.orderId} creado, pero falló un efecto posterior: ${errorMessage(error)}`,
      );
    }
    return { order: await this.releerOUsar(savedOrder), paymentUrl };
  }

  /** El pedido completo; si la relectura falla, el recién guardado. */
  private async releerOUsar(savedOrder: Order): Promise<Order> {
    try {
      const completo = await this.orders.findByIdFull(savedOrder.orderId);
      if (completo) return completo;
    } catch (error) {
      this.logger.error(
        `No se pudo releer el pedido ${savedOrder.orderId}: ${errorMessage(error)}`,
      );
    }
    marcarRespuestaIncompleta();
    return savedOrder;
  }

  /**
   * Zona de cobertura: si la distribuidora definió zonas (PostGIS), la
   * dirección debe caer dentro de alguna; si no, se rechaza. La zona ganadora
   * puede tener un recargo fijo o porcentual. Sin zonas definidas (o sin punto
   * en la dirección) es un no-op y devuelve null.
   */
  async resolverZona(
    distributorId: string | null | undefined,
    address: { location?: Point | null },
  ): Promise<CoverageZoneResumenDto | null> {
    const punto = coordenadasDePunto(address.location);
    if (!distributorId || !punto) return null;
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
    return coverage.zone;
  }

  /**
   * Reserva el stock de cada renglón (lock pesimista, dentro de la transacción
   * de `manager`) y lo valoriza con el precio de SERVIDOR más las promociones
   * por volumen. Compartido por el alta y la edición del pedido.
   */
  async reservarRenglones(
    manager: EntityManager,
    items: Array<{ gasCylinderId: string; quantity: number }>,
    distributorId: string | null | undefined,
    /** La edición de un pedido ya ajustó la reserva (neta): sólo se bloquea y se lee el precio. */
    stockYaReservado = false,
  ): Promise<{
    orderItems: OrderItem[];
    checkoutItems: PaymentCheckoutItem[];
    subtotalItems: Decimal;
  }> {
    let subtotalItems = new Decimal(0);
    const orderItems: OrderItem[] = [];
    // Ítems para el checkout de MercadoPago (título legible + precio de
    // SERVIDOR). Se arman en el mismo loop para no releer las garrafas.
    const checkoutItems: PaymentCheckoutItem[] = [];

    // Los locks de las garrafas se toman siempre en el mismo orden (por id):
    // dos pedidos con las mismas garrafas en distinto orden no se cruzan.
    const ordenados = [...items].sort((a, b) =>
      a.gasCylinderId.localeCompare(b.gasCylinderId),
    );
    for (const itemDto of ordenados) {
      // Devuelve la garrafa bloqueada para leer precio/promos de la misma fila.
      const gasCylinder = stockYaReservado
        ? await this.stock.leerBloqueada(manager, itemDto.gasCylinderId)
        : await this.stock.reservarStock(
            manager,
            itemDto.gasCylinderId,
            itemDto.quantity,
          );

      const renglon = this.valorizarRenglon(
        gasCylinder,
        itemDto,
        distributorId,
      );
      subtotalItems = subtotalItems.plus(renglon.subtotal);
      orderItems.push(renglon.orderItem);
      checkoutItems.push(renglon.checkoutItem);
    }

    return { orderItems, checkoutItems, subtotalItems };
  }

  /**
   * Valoriza un renglón con el precio de SERVIDOR y las promociones por
   * volumen. Es la única regla de precio por renglón: la usan el alta, la
   * edición y la cotización.
   */
  valorizarRenglon(
    gasCylinder: GasCylinder,
    itemDto: { gasCylinderId: string; quantity: number },
    distributorId: string | null | undefined,
  ): {
    orderItem: OrderItem;
    checkoutItem: PaymentCheckoutItem;
    subtotal: Decimal;
  } {
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

    return {
      orderItem: this.orderItemRepository.create({
        gasCylinderId: itemDto.gasCylinderId,
        quantity: itemDto.quantity,
        unitPrice: unitPrice.toNumber(),
        subtotal: subtotal.toNumber(),
      }),
      checkoutItem: {
        id: itemDto.gasCylinderId,
        title: `Garrafa ${gasCylinder.type}`,
        quantity: itemDto.quantity,
        unitPrice: unitPrice.toNumber(),
      },
      subtotal,
    };
  }

  /**
   * Total del pedido a partir del subtotal de ítems (YA con promociones):
   * recargo de zona (fijo, o porcentual sobre el subtotal) y DESPUÉS recargo
   * por método de pago (+10% online), que se aplica sobre el total con el
   * recargo de zona ya sumado.
   */
  calcularTotales(
    subtotalItems: Decimal.Value,
    coverageZone: ZonaParaRecargo | null,
    paymentMethod: PaymentMethod,
  ): { totalAmount: Decimal; zoneSurchargeAmount: Decimal } {
    const zoneSurchargeAmount = this.coverageZonePricing.zoneSurcharge(
      subtotalItems,
      coverageZone,
    );
    const totalAmount = this.pricing.applyPaymentSurcharge(
      zoneSurchargeAmount.plus(subtotalItems),
      paymentMethod,
    );
    return { totalAmount, zoneSurchargeAmount };
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
