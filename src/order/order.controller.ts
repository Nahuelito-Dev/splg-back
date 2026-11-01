// order/order.controller.ts
import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  Res,
  ParseUUIDPipe,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBearerAuth,
  ApiUnauthorizedResponse,
  ApiNotFoundResponse,
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiNoContentResponse,
  ApiCreatedResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
} from '@nestjs/swagger';
import { OrderService } from './order.service';
import { UpdateOrderUseCase } from './application/update-order.use-case';
import { ChangeOrderAddressUseCase } from './application/change-order-address.use-case';
import { SetOrderReceiverUseCase } from './application/set-order-receiver.use-case';
import { ChangeOrderAddressDto } from './dto/change-order-address.dto';
import { SetOrderReceiverDto } from './dto/set-order-receiver.dto';
import { QuoteOrderUseCase } from './application/quote-order.use-case';
import { QuoteOrderDto, QuoteResponseDto } from './dto/quote-order.dto';
import { CashCollectionUseCase } from './application/cash-collection.use-case';
import {
  ResolveUnpaidDto,
  ResolveUnpaidResponseDto,
} from './dto/resolve-unpaid.dto';
import { ConfirmTransferDto, RegisterCashDto } from './dto/payment-admin.dto';
import { ReservationService } from './application/reservation.service';
import {
  cancelledByDe,
  mapRoleToCancelActor,
} from './application/cancel-order.use-case';
import type { CancelActor } from './application/cancel-order.use-case';
import { OrderMapper } from './order.mapper';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { ConfirmDeliveryDto } from './dto/confirm-delivery.dto';
import { UpdateLocationDto } from './dto/update-location.dto';
import { CancelOrderDto } from './dto/cancel-order.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { OrderStatusHistoryEntryDto } from './dto/order-status-history-response.dto';
import { QueryOrdersDto } from './dto/query-orders.dto';
import {
  CodigoDeEntregaResponseDto,
  AvailableOrdersResponseDto,
  PaginatedOrdersResponseDto,
  RechazoDeOfertaResponseDto,
  ReservaResponseDto,
} from './dto/order-listados-response.dto';
import {
  OrderStatsResponseDto,
  SalesChartPointDto,
} from './dto/order-stats-response.dto';
import { MessageResponseDto } from '../common/dtos/message-response.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { errorMessage } from '../common/errors/error-message';
import { Order, OrderStatus, PaymentMethod } from './entities/order.entity';
import { Auth } from '../common/decorators/auth.decorator';
import type { Response } from 'express';
import { DownloadQueryDto } from '../s3/dto/download-link.dto';
import { ApiVerFoto, responderFoto } from '../s3/photo-http';
import { OrderDriverPhotoService } from './application/order-driver-photo.service';
import { RoleType } from '../common/constants/role-type.enum';
import { TruckLoadGatePort } from './domain/ports/truck-load-gate.port';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { withTransactionRetry } from '../common/utils/with-transaction-retry';
import { Idempotent } from '../common/decorators/idempotent.decorator';

import { ClassSerializerInterceptor, UseInterceptors } from '@nestjs/common';
import { marcarRespuestaIncompleta } from '../common/interceptors/respuesta-incompleta';

@ApiTags('Orders')
@ApiBearerAuth()
@UseInterceptors(ClassSerializerInterceptor)
@Controller('orders')
export class OrderController {
  private readonly logger = new Logger(OrderController.name);

  constructor(
    private readonly orderService: OrderService,
    private readonly reservationService: ReservationService,
    private readonly updateOrderUseCase: UpdateOrderUseCase,
    private readonly cashCollection: CashCollectionUseCase,
    private readonly quoteOrder: QuoteOrderUseCase,
    private readonly driverPhoto: OrderDriverPhotoService,
    // D5: el chofer sin la carga del día abierta no ve el pool si se exige.
    private readonly truckLoadGate: TruckLoadGatePort,
    private readonly changeAddressUseCase: ChangeOrderAddressUseCase,
    private readonly setReceiverUseCase: SetOrderReceiverUseCase,
  ) {}

  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Create a new order',
    description:
      'Idempotente vía header `Idempotency-Key` (UUID v4). Reintentos con la misma key retornan la respuesta cacheada por 24h.',
  })
  @ApiCreatedResponse({ type: OrderResponseDto, description: 'Pedido creado' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({
    status: 409,
    description: 'Otro request con la misma Idempotency-Key está en curso',
  })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos: items vacío, scheduledDate pasada (día argentino) o reserva sin fecha',
  })
  async create(
    @Body() createOrderDto: CreateOrderDto,
    @CurrentUser() user: AuthenticatedUser,
    // Opcional para compatibilidad: si el cliente no manda X-Distributor (apps
    // previas al multi-tenant), el use-case cae a la distribuidora default.
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
  ) {
    // Anti-impersonación: un cliente solo puede crear pedidos para SÍ MISMO
    // (order.customer_id es el User PK = user.user_id). Admin/delivery pueden
    // crear a nombre de un cliente (soporte / carga telefónica).
    if (
      user.role === RoleType.CUSTOMER &&
      createOrderDto.customerId !== user.user_id
    ) {
      throw new ForbiddenException(
        'No autorizado a crear pedidos para otro cliente',
      );
    }
    this.exigirClienteParaCarrito(createOrderDto.fromCart, user);
    // La venta a cuenta corriente la carga el administrador desde el panel: ni el
    // cliente ni el chofer eligen cuánto crédito usan.
    if (
      createOrderDto.paymentMethod === PaymentMethod.ACCOUNT &&
      user.role !== RoleType.ADMIN &&
      user.role !== RoleType.SUPER_ADMIN
    ) {
      throw new ForbiddenException(
        'La venta a cuenta corriente sólo la registra un administrador',
      );
    }
    // Retry ante deadlock / serialization_failure de PostgreSQL.
    // Ocurre cuando dos transacciones concurrentes intentan adquirir
    // pessimistic locks sobre las mismas garrafas en orden distinto.
    // El pedido nace atado a la distribuidora que el cliente eligió (X-Distributor).
    const { order, paymentUrl } = await withTransactionRetry(
      () => this.orderService.create(createOrderDto, distributorId),
      { context: 'OrderService.create' },
    );
    const dto = OrderMapper.toDto(order);
    // Solo presente para paymentMethod MERCADOPAGO (checkout de Checkout Pro).
    dto.paymentUrl = paymentUrl;
    return dto;
  }

  /** El carrito es del cliente: el personal que carga un pedido a su nombre manda los `items`. */
  private exigirClienteParaCarrito(
    fromCart: boolean | undefined,
    user: AuthenticatedUser,
  ): void {
    if (fromCart && user.role !== RoleType.CUSTOMER) {
      throw new ForbiddenException(
        'fromCart es del cliente: el personal manda los items',
      );
    }
  }

  @Post('quote')
  @Auth(RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Cotizar un pedido',
    description:
      'Mismo cuerpo que `POST /orders` (sólo `items` y `paymentMethod` son obligatorios). Devuelve el desglose que cobrará el alta: renglones con la promoción por volumen, `subtotal`, recargo de zona (con `addressId`; el admin además manda `customerId`), recargo por medio de pago (`paymentSurchargePercentage` % sobre subtotal + zona: parámetro de la distribuidora por medio de pago, por omisión 10 en `mercadopago` y `transfer` y 0 en `cash`), `deposit` (si `isReservation`), `total` y `balance` (`total - deposit`). El `total` es exactamente el del pedido que se crea con el mismo cuerpo. No escribe nada ni reserva stock; sí rechaza lo que el alta rechazaría (producto de otra distribuidora, sin stock, dirección fuera de cobertura). Cliente sin `X-Distributor`: distribuidora por defecto, igual que el alta. Con `orderId` cotiza la EDICIÓN de ese pedido (mismas reglas que `PATCH /orders/:id`): pedido ajeno o inexistente 404, no editable 409, stock por diferencia contra lo ya reservado, franja y fecha sólo si cambian.',
  })
  @ApiOkResponse({ type: QuoteResponseDto })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos, sin stock, dirección fuera de cobertura, o falta `customerId` con `addressId` (admin)',
  })
  @ApiForbiddenResponse({ description: 'Un cliente cotizando para otro' })
  @ApiNotFoundResponse({
    description: 'Con `orderId`: el pedido no existe o no es del cliente',
  })
  @ApiConflictResponse({
    description: 'Con `orderId`: el pedido no es editable',
  })
  @HttpCode(200)
  quote(
    @Body() dto: QuoteOrderDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
  ): Promise<QuoteResponseDto> {
    this.exigirClienteParaCarrito(dto.fromCart, user);
    return this.quoteOrder.execute(dto, distributorId, {
      userId: user.user_id,
      role: user.role,
    });
  }

  @Get()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Get all orders with pagination',
    description:
      'Admite `term` (nombre/email/teléfono del cliente o los últimos ' +
      'caracteres del id del pedido), `status` y rango `from`/`to` (fecha ' +
      'local, `to` inclusivo).',
  })
  @ApiOkResponse({ type: PaginatedOrdersResponseDto })
  @ApiBadRequestResponse({
    description: 'status, from o to inválidos, o from posterior a to',
  })
  async findAll(
    @Query() queryDto: QueryOrdersDto,
    @CurrentDistributor() distributorId: string | null,
  ) {
    // Admin de distribuidora → sólo sus pedidos; super_admin sin header → todos.
    const result = await this.orderService.findAll(queryDto, distributorId);
    return {
      ...result,
      orders: result.orders.map((order) => OrderMapper.toDto(order)),
    };
  }

  @Get('customer/:customerId')
  @Auth(RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Get orders by customer ID',
    description:
      'Cliente (el suyo), admin y super_admin. El chofer no lista pedidos por cliente: los suyos están en `GET /orders/delivery/:deliveryId` (403 si lo intenta).',
  })
  @ApiParam({ name: 'customerId', description: 'Customer UUID' })
  @ApiOkResponse({ type: PaginatedOrdersResponseDto })
  async findByCustomer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query() paginationDto: PaginationDto,
    @CurrentDistributor() distributorId: string | null,
  ) {
    // Ownership: un cliente solo puede ver SUS pedidos. Admin ve los de cualquiera.
    // (order.customer_id es el User PK, igual que user.user_id.)
    if (user.role === RoleType.CUSTOMER && user.user_id !== customerId) {
      throw new ForbiddenException(
        'No autorizado a ver pedidos de otro cliente',
      );
    }
    // El staff (admin) sólo ve pedidos de su distribuidora; el cliente
    // ve TODO su historial (aunque haya pedido a varias) → sin scope de tenant.
    const scope = user.role === RoleType.CUSTOMER ? null : distributorId;
    const result = await this.orderService.findByCustomer(
      customerId,
      paginationDto,
      scope,
    );
    return {
      ...result,
      orders: result.orders.map((order) => OrderMapper.toDto(order)),
    };
  }

  @Get('delivery/me/active')
  @Auth(RoleType.DELIVERY)
  @ApiOperation({
    summary: 'El pedido en curso del chofer (para retomar al abrir la app)',
    description:
      'Devuelve el pedido que el chofer tiene en curso, sin importar cuándo se creó: el que lleva `out_for_delivery` o, si no, el `accepted` más antiguo. Si no tiene ninguno, el pedido entregado HOY en efectivo cuyo cobro sigue `pending` (para que confirme el cobro). Responde `204` sin cuerpo si no tiene nada de eso. Sólo del chofer autenticado y de su distribuidora.',
  })
  @ApiOkResponse({ type: OrderResponseDto })
  @ApiNoContentResponse({
    description: 'El chofer no tiene un pedido en curso',
  })
  async findMyActive(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderResponseDto | undefined> {
    const order = await this.orderService.findCurrentOfDriver(
      user.user_id,
      distributorId,
    );
    if (!order) {
      res.status(HttpStatus.NO_CONTENT);
      return undefined;
    }
    return order;
  }

  @Get('delivery/:deliveryId')
  @Auth(RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get orders by delivery ID' })
  @ApiParam({ name: 'deliveryId', description: 'Delivery UUID' })
  @ApiOkResponse({ type: PaginatedOrdersResponseDto })
  async findByDelivery(
    @CurrentUser() user: AuthenticatedUser,
    @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
    @Query() paginationDto: PaginationDto,
    @CurrentDistributor() distributorId: string | null,
  ) {
    if (user.role === RoleType.DELIVERY) {
      await this.orderService.assertEsElChofer(deliveryId, user.user_id);
    }
    const result = await this.orderService.findByDelivery(
      deliveryId,
      paginationDto,
      distributorId,
    );
    return {
      ...result,
      orders: result.orders.map((order) => OrderMapper.toDto(order)),
    };
  }

  @Get('available')
  @Auth(RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get available orders for delivery' })
  @ApiOkResponse({
    type: AvailableOrdersResponseDto,
    description:
      'Si el chofer no puede recibir pedidos por su carga de camión (sin carga con el control activo, carga sin salir o ya devuelta), `orders` viene vacío, `openLoadRequired` es true y `message` dice por qué ("Abrí tu carga para recibir pedidos"). La app también lo sabe por `GET /truck-loads/mine`.',
  })
  async findAvailableOrders(
    @Query() paginationDto: PaginationDto,
    @CurrentDistributor() distributorId: string | null,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AvailableOrdersResponseDto> {
    const { limit = 10, offset = 0 } = paginationDto;
    const motivo =
      user.role === RoleType.DELIVERY && distributorId
        ? await this.truckLoadGate.motivoParaNoRecibir(
            distributorId,
            user.user_id,
          )
        : null;
    if (motivo) {
      return {
        orders: [],
        total: 0,
        limit,
        offset,
        openLoadRequired: true,
        message: motivo,
      };
    }
    // Pool de pedidos disponibles ACOTADO a la distribuidora del chofer.
    // Los pedidos express no están en el pool del chofer (se ofrecen de a uno a
    // las motos), pero el panel y el staff sí los ven.
    const result = await this.orderService.findAvailableOrders(
      paginationDto,
      distributorId,
      user.role !== RoleType.DELIVERY,
    );
    return {
      ...result,
      // El pool es de pedidos sin chofer: quién recibe todavía no es de nadie.
      orders: result.orders.map((order) => {
        const dto = OrderMapper.toDto(order);
        dto.receiver = null;
        return dto;
      }),
      openLoadRequired: false,
      message: null,
    };
  }

  @Get('reservations')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Listar las reservas (pedidos RESERVED) con estado de seña',
  })
  @ApiOkResponse({ type: ReservaResponseDto, isArray: true })
  @ApiBadRequestResponse({
    description:
      'Super admin sin X-Distributor ("Falta la distribuidora: enviá el header X-Distributor (slug o id)")',
  })
  async findReservations(
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
  ) {
    return this.reservationService.findReservations(distributorId);
  }

  @Get(':id/driver-photo')
  @Auth(
    RoleType.CUSTOMER,
    RoleType.DELIVERY,
    RoleType.ADMIN,
    RoleType.SUPER_ADMIN,
  )
  @ApiVerFoto('Foto del chofer asignado al pedido')
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiConflictResponse({
    description: 'El pedido no está aceptado ni en camino',
  })
  @ApiForbiddenResponse({ description: 'El pedido lo tiene otro chofer' })
  async getDriverPhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DownloadQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
    @Res() res: Response,
  ): Promise<void> {
    responderFoto(
      res,
      query.modo,
      await this.driverPhoto.enlace(id, user, distributorId),
    );
  }

  @Get(':id/status-history')
  @Auth(
    RoleType.CUSTOMER,
    RoleType.DELIVERY,
    RoleType.ADMIN,
    RoleType.SUPER_ADMIN,
  )
  @ApiOperation({
    summary: 'Historial de estados del pedido',
    description:
      'Del más viejo al más nuevo: de qué estado a cuál, cuándo, quién y el motivo. Las filas con `isNote: true` (origen = destino) son anotaciones de un cobro manual del admin, no cambios de estado. La regla de lectura es la de `GET /orders/:id`: el cliente sólo los suyos, el chofer los que ve en el detalle, admin y super admin los de su distribuidora (el super admin tiene que mandar `X-Distributor`: sin él, 400); lo ajeno responde 404. `changedBy.fullName` sólo lo ven admin y super admin. Los pedidos anteriores al historial no tienen sus transiciones pasadas.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({ type: OrderStatusHistoryEntryDto, isArray: true })
  @ApiBadRequestResponse({
    description: 'El super admin no mandó `X-Distributor`',
  })
  @ApiNotFoundResponse({ description: 'Pedido no encontrado' })
  @ApiResponse({
    status: 410,
    description:
      'Sólo para el chofer: el pedido lo tuvo él y ya no es suyo (igual que `GET /orders/:id`).',
  })
  async statusHistory(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
  ) {
    return this.orderService.getStatusHistory(
      id,
      distributorId,
      user.role === RoleType.CUSTOMER ? user.user_id : undefined,
      user.role === RoleType.DELIVERY ? user.user_id : undefined,
      user.role === RoleType.ADMIN || user.role === RoleType.SUPER_ADMIN,
    );
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get order by ID',
    description:
      'El cliente lee sólo sus pedidos. El chofer lee el pedido que tiene asignado, el que tiene en oferta vigente o uno del pool de `GET /orders/available` (pendiente, sin chofer, de su distribuidora); cualquier otro responde 404 como si no existiera. Admin y super_admin leen los de su distribuidora.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({ type: OrderResponseDto })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiBadRequestResponse({
    description:
      'Super admin sin X-Distributor ("Falta la distribuidora: enviá el header X-Distributor (slug o id)")',
  })
  @ApiResponse({
    status: 410,
    description:
      'Sólo para el chofer: el pedido lo tuvo él y ya no es suyo (lo liberó el admin, lo reasignaron o el control de carga lo sacó del pool). La app debe salir de la pantalla del pedido.',
  })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
  ) {
    // Un CUSTOMER solo lee SUS pedidos (ownership); staff scopea por tenant
    // (el super admin sin `X-Distributor` recibe 400: no lee pedidos ni enlaces
    // de pago de cualquier distribuidora).
    const customerScope =
      user.role === RoleType.CUSTOMER ? user.user_id : undefined;
    const choferScope =
      user.role === RoleType.DELIVERY ? user.user_id : undefined;
    return await this.orderService.getOne(
      id,
      distributorId,
      customerScope,
      choferScope,
      user.role !== RoleType.DELIVERY,
    );
  }

  @Patch(':id/status')
  @Auth(RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @Idempotent()
  @ApiOperation({
    summary: 'Update order status',
    description:
      'Idempotente vía header `Idempotency-Key`. Evita doble aceptación/entrega por reintento de red. Solo chofer/admin.\n\n' +
      '- `status: cancelled` (cliente y admin: `reason` obligatorio, 400 si falta o está en blanco) tiene EXACTAMENTE el mismo efecto que `PATCH /:id/cancel` (mismo código, mismo stock, mismos ' +
      'avisos): cancela con devolución de stock si lo pide un admin, o LIBERA el pedido a `pending` (sin devolver stock, ' +
      'sin motivo de cancelación) si lo pide el chofer — no cancela de verdad.\n' +
      '- `status: pending` sobre un pedido ACCEPTED/ON_THE_WAY libera al chofer asignado (mismo camino que el punto ' +
      'anterior): limpia el chofer, corta su tracking, cierra cualquier oferta que hubiera quedado y avisa al chofer ' +
      'anterior, al cliente y al panel. `POST /:id/reject` sobre una asignación manual NO usa este camino: no libera, ' +
      'sólo avisa al panel (ver `/reject`).\n' +
      '- `status: pending` sobre una RESERVA (pedido `reserved`) la ACTIVA a mano, con las mismas condiciones que el cron ' +
      '(seña paga y día agendado cumplido) — sólo admin/super_admin, 400 claro si no las cumple.\n' +
      '- `status: accepted` sobre un pedido YA `accepted` con el MISMO chofer es idempotente: no regenera `acceptedAt` ' +
      'ni el código de entrega (pasa cuando el chofer "acepta" el aviso de una asignación manual).\n' +
      '- `status: delivered` NO lo puede pedir el chofer (403): la entrega se confirma con el QR del cliente en ' +
      '`POST /:id/confirm-delivery`. El admin/super_admin sí puede marcarla por acá (cliente sin celular), pero tiene que mandar `reason` (mínimo 10 caracteres, 400 si falta): queda en el historial de estados (`order_status_history`) y en la auditoría de datos (campo `manualDeliveryReason` del `Order`).',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({
    type: OrderResponseDto,
    description:
      'Estado actualizado, o devuelto a pendiente si lo libera el chofer',
  })
  @ApiResponse({
    status: 403,
    description:
      'El pedido no está asignado a este chofer, un chofer intentó activar una reserva a mano, o un chofer intentó marcar ' +
      '`delivered` (la entrega se confirma con el QR del cliente)',
  })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiConflictResponse({
    description:
      'Aceptar (`accepted`) un pedido de Mercado Pago cuyo pago todavía no está aprobado (salvo una reserva con la seña paga)',
  })
  @ApiBadRequestResponse({
    description:
      'Transición de pedido inválida: cancelled → accepted · status debe ser uno de: reserved, pending, accepted, ' +
      'on_the_way, delivered, cancelled · la reserva no tiene la seña paga o todavía no llegó su fecha agendada · ' +
      'al aceptar (status=accepted), el repartidor está deshabilitado, no está validado, o tiene un documento de ' +
      'flota vencido que lo inhabilita (seguro, VTV o licencia)',
  })
  async updateStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateOrderStatusDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ) {
    await this.orderService.assertDeLaDistribuidora(id, distributorId);
    // Un chofer solo puede operar EN SU NOMBRE: ignoramos cualquier deliveryId
    // del body y usamos su identidad autenticada (updateStatus resuelve el perfil
    // Delivery por user_id). El admin sí puede asignar a un chofer arbitrario.
    const isDriver = user.role === RoleType.DELIVERY;
    const deliveryId = isDriver ? user.user_id : body.deliveryId;

    const order = await this.orderService.updateStatus(
      id,
      body.status,
      deliveryId,
      user.role,
      // El actor sale SIEMPRE del token: lo usa el caso `status: cancelled`,
      // que delega en la misma cancelación que `PATCH /:id/cancel`.
      user.user_id,
      body.reason,
    );
    return OrderMapper.toDto(order);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Auth(RoleType.DELIVERY)
  @Idempotent()
  @ApiOperation({
    summary:
      'Chofer rechaza/ignora una oferta de pedido (CU-016) o una asignación manual (H-55)',
    description:
      'Oferta real del despacho automático: cierra la oferta activa del chofer como REJECTED y re-ofrece el pedido ' +
      'al siguiente chofer más cercano de inmediato (sin esperar el timeout).\n\n' +
      'Asignación MANUAL del admin (el chofer la recibe con el mismo evento de socket que una oferta, pero nunca hubo ' +
      'una fila `OFFERED` que cerrar): el pedido NO cambia. La app manda este mismo endpoint tanto si el chofer lo ' +
      'rechaza a propósito como si deja vencer el aviso sin tocarlo, así que "rechazarla" no puede deshacer sola una ' +
      'asignación que un admin decidió a mano — se avisa al panel (`order:assignment-declined`) para que decida un ' +
      'humano (reasignar, insistir, etc.); el pedido sigue asignado a este chofer.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({ type: RechazoDeOfertaResponseDto })
  @ApiNotFoundResponse({
    description: 'El pedido no existe o es de otra distribuidora',
  })
  async rejectOffer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ) {
    await this.orderService.assertDeLaDistribuidora(id, distributorId);
    return this.orderService.rejectOffer(id, user.user_id);
  }

  @Get(':id/delivery-code')
  @Auth(RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Obtener el código secreto de entrega (para el QR del chofer)',
    description:
      'El chofer renderiza este código como QR y lo muestra al cliente al llegar. ' +
      'Solo existe si el pedido ya fue aceptado. El chofer solo puede ver el de SUS pedidos.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({ type: CodigoDeEntregaResponseDto })
  @ApiResponse({
    status: 400,
    description: 'El pedido aún no tiene código (no aceptado)',
  })
  @ApiResponse({
    status: 403,
    description: 'El pedido no está asignado a este chofer',
  })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async getDeliveryCode(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ) {
    await this.orderService.assertDeLaDistribuidora(id, distributorId);
    return this.orderService.getDeliveryCode(id, user.user_id, user.role);
  }

  @Post(':id/confirm-delivery')
  @Auth(RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @Idempotent()
  @ApiOperation({
    summary:
      'Confirmar entrega escaneando el QR del chofer (prueba anti-fraude)',
    description:
      'El cliente escanea el QR que muestra el chofer y envía el código leído. ' +
      'Si coincide con `order.deliveryCode` y el pedido está ON_THE_WAY, se marca DELIVERED. ' +
      'Idempotente vía header `Idempotency-Key`: reintentos de red no re-procesan la entrega. ' +
      'Si lo confirma un admin/super_admin, `reason` es obligatorio (10 a 500 caracteres, 400 si falta) y queda ' +
      'en el historial de estados y en la auditoría; para el cliente no se pide y se ignora.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiCreatedResponse({
    type: OrderResponseDto,
    description: 'Entrega confirmada',
  })
  @ApiResponse({
    status: 400,
    description: 'Código inválido o el pedido no está en camino',
  })
  @ApiResponse({
    status: 403,
    description: 'No autorizado (pedido de otro cliente)',
  })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async confirmDelivery(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ConfirmDeliveryDto,
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
  ) {
    await this.orderService.assertDeLaDistribuidora(id, distributorId);
    const order = await this.orderService.confirmDelivery(
      id,
      body.code,
      user.user_id,
      user.role,
      body.reason,
    );
    return OrderMapper.toDto(order);
  }

  @Patch(':id/payment/cash-received')
  @Auth(RoleType.DELIVERY)
  @Idempotent()
  @ApiOperation({
    summary: 'El chofer confirma que cobró el efectivo ("pago recibido")',
    description:
      'Sin body. Entregar un pedido en efectivo no lo marca pagado: queda `paymentStatus: pending` hasta ' +
      'que el chofer asignado confirma acá que cobró. Pasa a `paid` y registra `paymentConfirmedAt` y ' +
      '`paymentConfirmedBy` (el chofer). Sólo pedidos `delivered` pagados en efectivo. Repetirlo sobre un ' +
      'pedido ya `paid` devuelve el pedido tal cual (idempotente; también vía header `Idempotency-Key`). ' +
      'Si el pago ya se informó como impago responde 409: lo resuelve un admin.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({
    type: OrderResponseDto,
    description: 'Pedido con `paymentStatus: paid`',
  })
  @ApiBadRequestResponse({
    description: 'El pedido no está entregado o no se pagó en efectivo',
  })
  @ApiResponse({
    status: 403,
    description: 'El pedido no está asignado a este chofer',
  })
  @ApiNotFoundResponse({ description: 'Pedido no encontrado' })
  @ApiConflictResponse({
    description: 'El pago ya se informó como impago (lo resuelve un admin)',
  })
  async confirmCashReceived(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ) {
    await this.orderService.assertDeLaDistribuidora(id, distributorId);
    const { order } = await this.cashCollection.confirmReceived(
      id,
      user.user_id,
      distributorId,
    );
    return this.pedidoTrasElCobro(id, distributorId, order);
  }

  @Patch(':id/payment/resolve-unpaid')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @Idempotent()
  @ApiOperation({
    summary: 'Resolver un cobro en efectivo impago',
    description:
      'Cierra un pedido con `paymentStatus: unpaid`: `resolution: paid` (el cliente pagó después) o ' +
      '`resolution: written_off` (se da por perdido). Exige `note` con el motivo; quedan registrados ' +
      'quién y cuándo (`paymentResolvedBy`, `paymentResolvedAt`, `paymentResolutionNote`) y la auditoría; ' +
      '`paymentConfirmedAt/By` se llenan sólo con `paid` (una pérdida no es un cobro). Con `paid`, `cashBoxId` es la caja de efectivo donde entra lo cobrado (obligatoria si la distribuidora tiene alguna) y se asienta en la misma transacción. En la misma transacción ' +
      'cierra la incidencia `unpaid_collection` del pedido (`resolved`, con la misma nota). Repetir la resolución ' +
      '(mismo admin u otro) es idempotente: no toca la nota ni la incidencia y responde 200 con ' +
      '`alreadyResolved: true`; si cambió algo, `false`.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({ type: ResolveUnpaidResponseDto })
  @ApiBadRequestResponse({ description: 'resolution o note inválidos' })
  @ApiNotFoundResponse({ description: 'Pedido no encontrado' })
  @ApiConflictResponse({
    description: 'El pedido no tiene el pago informado como impago',
  })
  async resolveUnpaid(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveUnpaidDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ) {
    await this.orderService.assertDeLaDistribuidora(id, distributorId);
    const { changed, order: guardado } =
      await this.cashCollection.resolveUnpaid(
        id,
        user.user_id,
        dto.resolution,
        dto.note,
        distributorId,
        dto.cashBoxId,
      );
    const order = await this.pedidoTrasElCobro(id, distributorId, guardado);
    return Object.assign(order, { alreadyResolved: !changed });
  }

  @Patch(':id/payment/register-cash')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @Idempotent()
  @ApiOperation({
    summary: 'El admin registra el cobro en efectivo de un pedido entregado',
    description:
      'Para el efectivo que el chofer no confirmó (no lo hizo, ya no está). Sólo pedidos `delivered` en efectivo con el pago `pending`: pasa a `paid` y registra `paymentConfirmedBy` (el admin), `paymentResolvedBy/At` y el motivo en `paymentResolutionNote`. `reason` es obligatorio (10 a 500 caracteres) y queda en el historial de estados y en la auditoría. `cashBoxId` es la caja donde entra el efectivo: obligatoria si la distribuidora tiene alguna caja activa; asienta en la misma transacción una entrada de caja de efectivo por el saldo a cobrar (total menos la seña paga; categoría de sistema `order_payment`, referencia al pedido). Si la rendición del chofer ya tomó el pedido, 409. Repetirlo sobre un pedido ya `paid` devuelve el pedido tal cual y no asienta otra vez. Si el pago ya se informó como impago responde 409 (se resuelve con `resolve-unpaid`). `X-Distributor` es obligatorio para el super admin.',
  })
  @ApiOkResponse({ type: OrderResponseDto })
  @ApiBadRequestResponse({
    description:
      'Falta o es inválido el motivo, el pedido no está entregado o no es en efectivo, o falta la distribuidora',
  })
  @ApiConflictResponse({ description: 'El pago ya se informó como impago' })
  async registerCash(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegisterCashDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ) {
    await this.orderService.assertDeLaDistribuidora(id, distributorId);
    const { order } = await this.cashCollection.registerCashByAdmin(
      id,
      user.user_id,
      dto.reason,
      distributorId,
      dto.cashBoxId,
    );
    return this.pedidoTrasElCobro(id, distributorId, order);
  }

  @Patch(':id/payment/confirm-transfer')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @Idempotent()
  @ApiOperation({
    summary: 'El admin confirma (o marca como no recibida) una transferencia',
    description:
      'Sólo pedidos con medio `transfer`, no cancelados, con el pago `pending`. `received: true` pasa el pago a `paid` (registra `paymentConfirmedAt/By`) y recién ahí el pedido entregado cuenta como venta en los reportes; `received: false` lo deja en `failed` (aparece en `GET /reports/collections` como `notReceivedTransfer`). `reason` obligatorio (10 a 500 caracteres): queda en `paymentResolutionNote`, en el historial de estados y en la auditoría. Repetir la misma decisión devuelve el pedido tal cual; la contraria sobre algo ya decidido es 409. `X-Distributor` es obligatorio para el super admin.',
  })
  @ApiOkResponse({ type: OrderResponseDto })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos, el pedido no es una transferencia o está cancelado, o falta la distribuidora',
  })
  @ApiConflictResponse({
    description: 'La transferencia ya se resolvió con la decisión contraria',
  })
  async confirmTransfer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmTransferDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ) {
    await this.orderService.assertDeLaDistribuidora(id, distributorId);
    const { order } = await this.cashCollection.confirmTransfer(
      id,
      user.user_id,
      dto.received,
      dto.reason,
      distributorId,
    );
    return this.pedidoTrasElCobro(id, distributorId, order);
  }

  @Patch(':id/assign/:deliveryId')
  @Idempotent()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Assign order to delivery',
    description:
      'Asignación manual del admin: exige que el chofer esté habilitado y ' +
      'validado, y que ni su licencia ni el vehículo que maneja tengan un ' +
      'documento bloqueante vencido (seguro, VTV, licencia — CU-136 a ' +
      'CU-138). NO exige que esté en línea (a diferencia del despacho ' +
      'automático).',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiParam({ name: 'deliveryId', description: 'Delivery UUID' })
  @ApiOkResponse({ type: OrderResponseDto, description: 'Chofer asignado' })
  @ApiResponse({ status: 404, description: 'Order or delivery not found' })
  @ApiConflictResponse({
    description:
      'El pedido se paga con Mercado Pago y el pago todavía no está aprobado',
  })
  @ApiBadRequestResponse({
    description:
      'El repartidor está deshabilitado, no está validado, o tiene un ' +
      'documento de flota vencido que lo inhabilita (seguro, VTV o ' +
      'licencia)',
  })
  async assignDelivery(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ) {
    await this.orderService.assertDeLaDistribuidora(id, distributorId);
    const order = await this.orderService.assignDelivery(
      id,
      deliveryId,
      distributorId,
    );
    return OrderMapper.toDto(order);
  }

  @Patch(':id/location')
  @Auth(RoleType.DELIVERY)
  @ApiOperation({
    summary: 'El chofer del pedido reporta su posición',
    description:
      'Vía HTTP para cuando el socket no está conectado: la posición va al radar ' +
      '(Redis GEO), igual que `driver:update-location`. No modifica el pedido ni ' +
      'su punto de entrega (H-91).',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({
    type: OrderResponseDto,
    description: 'El pedido, sin cambios',
  })
  async updateLocation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateLocationDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ) {
    await this.orderService.assertDeLaDistribuidora(id, distributorId);
    const order = await this.orderService.updateLocation(
      id,
      body.lat,
      body.lng,
      user.user_id,
    );
    return OrderMapper.toDto(order);
  }

  @Get('stats/summary')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Get order statistics (scopeado por distribuidora)',
  })
  @ApiOkResponse({ type: OrderStatsResponseDto })
  async getStats(
    @CurrentDistributor() distributorId: string | null,
  ): Promise<OrderStatsResponseDto> {
    return await this.orderService.getOrderStats(distributorId);
  }

  @Patch(':id')
  @Auth(RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @Idempotent()
  @ApiOperation({
    summary: 'Editar un pedido pendiente (sin chofer asignado)',
    description:
      'Admin, super admin y el CLIENTE DUEÑO del pedido (uno ajeno es 404). ' +
      'Idempotente vía `Idempotency-Key`. Los precios y recargos los calcula SIEMPRE el servidor. ' +
      'El cliente deja una anotación en el historial de estados. ' +
      'Dirección, franja/fecha, medio de pago, notas y renglones. Si vienen ' +
      '`items` reemplazan a los actuales: se devuelve el stock viejo y se ' +
      'reserva el nuevo con los precios y recargos vigentes (mismas reglas ' +
      'que el alta). Fuera de `pending`, o con pago online, responde 409. ' +
      'Para eliminar un pedido: `PATCH /orders/:id/cancel`.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({ type: OrderResponseDto })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos, sin stock, dirección fuera de cobertura, scheduledDate pasada (día argentino) o items vacío',
  })
  @ApiConflictResponse({
    description:
      'El pedido no está pendiente, tiene chofer (cliente: «El pedido ya fue tomado por un repartidor: no se puede modificar») o pago online',
  })
  @ApiNotFoundResponse({ description: 'Order with ID: {id} not found' })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrderDto,
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
  ) {
    const order = await withTransactionRetry(
      () =>
        this.updateOrderUseCase.execute(
          id,
          dto,
          user.user_id,
          distributorId,
          user.role,
        ),
      { context: 'OrderService.update' },
    );
    return OrderMapper.toDto(order);
  }

  @Patch(':id/address')
  @Auth(RoleType.CUSTOMER)
  @Idempotent()
  @ApiOperation({
    summary: 'Cambiar la dirección de entrega de un pedido (cliente)',
    description:
      'CU-127. Sólo el CLIENTE DUEÑO (uno ajeno es 404), con el pedido pendiente o aceptado. ' +
      'La dirección nueva tiene que ser otra de las suyas y caer dentro de una zona de cobertura de la distribuidora del pedido. ' +
      'El recargo de la zona nueva se compara con el del pedido: en pago en línea (MercadoPago o transferencia) el importe ya está definido, ' +
      'así que si cambia responde 409 y el cliente debe cancelar y pedir de nuevo; en efectivo se recalcula el total. ' +
      'Actualiza el punto de entrega y deja el cambio asentado (dirección anterior, autor y motivo) en el historial de estados. ' +
      'Avisa al chofer asignado (`order:address-changed`) y al panel; si el pedido está pendiente, vence las ofertas vivas y vuelve a ofrecerlo. ' +
      'Idempotente vía `Idempotency-Key`.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({ type: OrderResponseDto })
  @ApiBadRequestResponse({
    description:
      'La dirección nueva es la actual, o queda fuera de la zona de cobertura («La dirección está fuera de la zona de cobertura de la distribuidora»)',
  })
  @ApiConflictResponse({
    description:
      'El pedido ya salió o fue entregado, no está pendiente/aceptado, o es de pago en línea y el recargo de la zona nueva es distinto',
  })
  @ApiNotFoundResponse({
    description:
      'Pedido ajeno o inexistente, o dirección que no es del cliente',
  })
  async changeAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeOrderAddressDto,
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
  ) {
    const order = await withTransactionRetry(
      () =>
        this.changeAddressUseCase.execute(id, dto, user.user_id, distributorId),
      { context: 'OrderService.changeAddress' },
    );
    return OrderMapper.toDto(order);
  }

  @Patch(':id/receiver')
  @Auth(RoleType.CUSTOMER)
  @Idempotent()
  @ApiOperation({
    summary: 'Indicar quién recibe el pedido (cliente)',
    description:
      'CU-128. Sólo el CLIENTE DUEÑO (uno ajeno es 404), mientras el pedido no esté entregado ni cancelado (409). ' +
      'Guarda nombre, documento y relación de quien recibe; la respuesta del pedido los expone como `receiver` sólo al cliente dueño, al chofer asignado y al administrador de la distribuidora. ' +
      'Son datos de un tercero: se anulan solos al vencer el plazo de reclamo (30 días desde la entrega o cancelación; con un reclamo abierto, hasta que se cierre) y ningún dato de quien recibe entra en la auditoría. ' +
      'Idempotente vía `Idempotency-Key`.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({ type: OrderResponseDto })
  @ApiBadRequestResponse({
    description: 'Datos inválidos (p. ej.: formato de documento)',
  })
  @ApiConflictResponse({
    description: 'El pedido ya fue entregado o está cancelado',
  })
  @ApiNotFoundResponse({ description: 'Pedido ajeno o inexistente' })
  async setReceiver(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetOrderReceiverDto,
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
  ) {
    await this.setReceiverUseCase.execute(id, dto, user.user_id, distributorId);
    return this.orderService.getOne(id, distributorId, user.user_id);
  }

  @Delete(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Cancel order (Admin Force)',
    deprecated: true,
    description:
      'Duplica `PATCH /orders/:id/cancel` (delega en la MISMA cancelación, mismo stock, mismos avisos). ' +
      'Se mantiene sólo por compatibilidad con clientes existentes: usar `/cancel` en código nuevo.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({
    type: OrderResponseDto,
    description: 'Pedido cancelado por el administrador',
  })
  @ApiBadRequestResponse({
    description: 'No se puede cancelar un pedido finalizado',
  })
  @ApiNotFoundResponse({ description: 'Order with ID: {id} not found' })
  async cancelOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ) {
    await this.orderService.assertDeLaDistribuidora(id, distributorId);
    // Cancelación forzada por admin. La identidad sale del token, no de un id
    // ficticio hardcodeado.
    const order = await this.orderService.cancelOrder(
      id,
      user.user_id,
      'admin',
      // Este endpoint no recibe cuerpo, y la cancelación exige motivo.
      'Cancelación forzada por el administrador',
    );
    return this.pedidoCancelado(order, 'admin');
  }

  @Patch(':id/cancel')
  @Auth(
    RoleType.CUSTOMER,
    RoleType.DELIVERY,
    RoleType.ADMIN,
    RoleType.SUPER_ADMIN,
  )
  @Idempotent()
  @ApiOperation({
    summary: 'Cancelar pedido (Cliente/Chofer/Admin)',
    description:
      'Idempotente vía header `Idempotency-Key`. Cancelaciones repetidas con la misma key son no-op. El actor (id + rol) sale SIEMPRE del token autenticado, nunca del body (evita IDOR).',
  })
  @ApiBadRequestResponse({
    description:
      'Falta el motivo (`reason`: obligatorio para cliente y administrador, no para el chofer que libera el pedido), motivo en blanco, o datos inválidos (p. ej.: reason must be shorter than or equal to 500 characters)',
  })
  @ApiNotFoundResponse({ description: 'Order with ID: {id} not found' })
  @ApiOkResponse({
    type: OrderResponseDto,
    description:
      'Pedido cancelado, o devuelto a pendiente si lo libera el chofer',
  })
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelOrderDto,
    @CurrentDistributor({ required: 'staff' }) distributorId: string | null,
  ) {
    await this.orderService.assertDeLaDistribuidora(id, distributorId);
    const actor = mapRoleToCancelActor(user.role);
    const order = await this.orderService.cancelOrder(
      id,
      user.user_id,
      actor,
      body.reason,
    );
    return this.pedidoCancelado(order, actor);
  }

  @Patch(':id/arrived')
  @Auth(RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Avisar al cliente que el repartidor llegó',
    description:
      'El chofer la dispara al llegar al domicilio (pedido ON_THE_WAY). Notifica ' +
      'al cliente por socket y por push, no cambia el estado del pedido. El ' +
      'chofer solo puede avisar la llegada de SUS pedidos.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({
    type: MessageResponseDto,
    description: 'Cliente notificado',
  })
  @ApiResponse({ status: 400, description: 'El pedido no está en camino' })
  @ApiResponse({
    status: 403,
    description: 'El pedido no está asignado a este chofer',
  })
  @ApiNotFoundResponse({ description: 'Order with ID: {id} not found' })
  async notifyArrival(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ) {
    await this.orderService.assertDeLaDistribuidora(id, distributorId);
    return this.orderService.notifyDriverArrived(id, user.user_id, user.role);
  }

  @Patch(':id/confirm-deposit')
  @Idempotent()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'Confirmar la seña de una reserva cobrada en efectivo o por transferencia',
    description:
      'Marca deposit_paid=true para una seña recibida en efectivo o por transferencia. Habilita la ' +
      'activación AUTOMÁTICA de la reserva (el cron la despacha el día agendado). La seña por ' +
      'MercadoPago se confirma sola vía webhook: confirmarla a mano es 400.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID (reserva)' })
  @ApiBadRequestResponse({
    description:
      'El pedido no es una reserva pendiente, o la seña es de MercadoPago (la confirma la pasarela)',
  })
  @ApiNotFoundResponse({ description: 'Reserva no encontrada' })
  @ApiOkResponse({ type: OrderResponseDto, description: 'Seña confirmada' })
  async confirmDeposit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const order = await this.reservationService.confirmDeposit(
      id,
      distributorId,
      user.user_id,
    );
    return OrderMapper.toDto(order);
  }

  @Get('stats/chart')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Get sales chart data (Last 7 days, scopeado por distribuidora)',
  })
  @ApiOkResponse({ type: SalesChartPointDto, isArray: true })
  async getChartData(
    @CurrentDistributor() distributorId: string | null,
  ): Promise<SalesChartPointDto[]> {
    return await this.orderService.getSalesChartData(distributorId);
  }

  /**
   * El pedido para la respuesta de una operación de cobro que ya se confirmó.
   * Si la relectura falla, se responde con el pedido que devolvió la
   * transacción: un 500 acá, con el cobro hecho, haría que el reintento con la
   * misma `Idempotency-Key` repitiera la operación en vez de devolver su resultado.
   */
  /**
   * La respuesta de una cancelación lleva `cancelledBy` igual que la lectura
   * posterior. Si el chofer "cancela" el pedido vuelve a pendiente: no está
   * cancelado y `cancelledBy` queda `null`.
   */
  private pedidoCancelado(order: Order, actor: CancelActor): OrderResponseDto {
    const dto = OrderMapper.toDto(order);
    if (order.status === OrderStatus.CANCELLED) {
      dto.cancelledBy = cancelledByDe(actor);
    }
    return dto;
  }

  private async pedidoTrasElCobro(
    id: string,
    distributorId: string | null,
    guardado: Order,
  ): Promise<OrderResponseDto> {
    try {
      return await this.orderService.getOne(id, distributorId);
    } catch (error) {
      this.logger.error(
        `No se pudo releer el pedido ${id} tras el cobro: ${errorMessage(error)}`,
      );
      marcarRespuestaIncompleta();
      return OrderMapper.toDto(guardado);
    }
  }
}
