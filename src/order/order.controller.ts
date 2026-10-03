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
  ParseUUIDPipe,
  ForbiddenException,
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
  ApiCreatedResponse,
} from '@nestjs/swagger';
import { OrderService } from './order.service';
import { ReservationService } from './application/reservation.service';
import { mapRoleToCancelActor } from './application/cancel-order.use-case';
import { OrderMapper } from './order.mapper';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { ConfirmDeliveryDto } from './dto/confirm-delivery.dto';
import { UpdateLocationDto } from './dto/update-location.dto';
import { CancelOrderDto } from './dto/cancel-order.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { QueryOrdersDto } from './dto/query-orders.dto';
import {
  CodigoDeEntregaResponseDto,
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
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { withTransactionRetry } from '../common/utils/with-transaction-retry';
import { Idempotent } from '../common/decorators/idempotent.decorator';

import { ClassSerializerInterceptor, UseInterceptors } from '@nestjs/common';

@ApiTags('Orders')
@ApiBearerAuth()
@UseInterceptors(ClassSerializerInterceptor)
@Controller('orders')
export class OrderController {
  constructor(
    private readonly orderService: OrderService,
    private readonly reservationService: ReservationService,
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
  async create(
    @Body() createOrderDto: CreateOrderDto,
    @CurrentUser() user: AuthenticatedUser,
    // Opcional para compatibilidad: si el cliente no manda X-Distributor (apps
    // previas al multi-tenant), el use-case cae a la distribuidora default.
    @CurrentDistributor() distributorId: string | null,
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
  @Auth(
    RoleType.CUSTOMER,
    RoleType.DELIVERY,
    RoleType.ADMIN,
    RoleType.SUPER_ADMIN,
  )
  @ApiOperation({ summary: 'Get orders by customer ID' })
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
    // El staff (admin/delivery) sólo ve pedidos de su distribuidora; el cliente
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
  @ApiOkResponse({ type: PaginatedOrdersResponseDto })
  async findAvailableOrders(
    @Query() paginationDto: PaginationDto,
    @CurrentDistributor() distributorId: string | null,
  ) {
    // Pool de pedidos disponibles ACOTADO a la distribuidora del chofer.
    const result = await this.orderService.findAvailableOrders(
      paginationDto,
      distributorId,
    );
    return {
      ...result,
      orders: result.orders.map((order) => OrderMapper.toDto(order)),
    };
  }

  @Get('reservations')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Listar las reservas (pedidos RESERVED) con estado de seña',
  })
  @ApiOkResponse({ type: ReservaResponseDto, isArray: true })
  async findReservations(@CurrentDistributor() distributorId: string | null) {
    return this.reservationService.findReservations(distributorId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get order by ID' })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiOkResponse({ type: OrderResponseDto })
  @ApiResponse({ status: 404, description: 'Order not found' })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ) {
    // Un CUSTOMER solo lee SUS pedidos (ownership); staff scopea por tenant.
    const customerScope =
      user.role === RoleType.CUSTOMER ? user.user_id : undefined;
    return await this.orderService.getOne(id, distributorId, customerScope);
  }

  @Patch(':id/status')
  @Auth(RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @Idempotent()
  @ApiOperation({
    summary: 'Update order status',
    description:
      'Idempotente vía header `Idempotency-Key`. Evita doble aceptación/entrega por reintento de red. Solo chofer/admin.\n\n' +
      '- `status: cancelled` tiene EXACTAMENTE el mismo efecto que `PATCH /:id/cancel` (mismo código, mismo stock, mismos ' +
      'avisos): cancela con devolución de stock si lo pide un admin, o LIBERA el pedido a `pending` (sin devolver stock, ' +
      'sin motivo de cancelación) si lo pide el chofer — no cancela de verdad.\n' +
      '- `status: pending` sobre un pedido ACCEPTED/ON_THE_WAY libera al chofer asignado (mismo camino que el punto ' +
      'anterior): limpia el chofer, corta su tracking, cierra cualquier oferta que hubiera quedado y avisa al chofer ' +
      'anterior, al cliente y al panel. `POST /:id/reject` sobre una asignación manual NO usa este camino: no libera, ' +
      'sólo avisa al panel (ver `/reject`).\n' +
      '- `status: pending` sobre una RESERVA (pedido `reserved`) la ACTIVA a mano, con las mismas condiciones que el cron ' +
      '(seña paga y día agendado cumplido) — sólo admin/super_admin, 400 claro si no las cumple.\n' +
      '- `status: accepted` sobre un pedido YA `accepted` con el MISMO chofer es idempotente: no regenera `acceptedAt` ' +
      'ni el código de entrega (pasa cuando el chofer "acepta" el aviso de una asignación manual).',
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
      'El pedido no está asignado a este chofer, o un chofer intentó activar una reserva a mano',
  })
  @ApiResponse({ status: 404, description: 'Order not found' })
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
    @CurrentDistributor() distributorId: string | null,
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
    );
    return OrderMapper.toDto(order);
  }

  @Post(':id/reject')
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
  async rejectOffer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
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
      'Idempotente vía header `Idempotency-Key`: reintentos de red no re-procesan la entrega.',
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
    @CurrentDistributor() distributorId: string | null,
  ) {
    await this.orderService.assertDeLaDistribuidora(id, distributorId);
    const order = await this.orderService.confirmDelivery(
      id,
      body.code,
      user.user_id,
      user.role,
    );
    return OrderMapper.toDto(order);
  }

  @Patch(':id/assign/:deliveryId')
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
  @ApiBadRequestResponse({
    description:
      'El repartidor está deshabilitado, no está validado, o tiene un ' +
      'documento de flota vencido que lo inhabilita (seguro, VTV o ' +
      'licencia)',
  })
  async assignDelivery(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
    @CurrentDistributor() distributorId: string | null,
  ) {
    await this.orderService.assertDeLaDistribuidora(id, distributorId);
    const order = await this.orderService.assignDelivery(id, deliveryId);
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
    @CurrentDistributor() distributorId: string | null,
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
    @CurrentDistributor() distributorId: string | null,
  ) {
    await this.orderService.assertDeLaDistribuidora(id, distributorId);
    // Cancelación forzada por admin. La identidad sale del token, no de un id
    // ficticio hardcodeado.
    const order = await this.orderService.cancelOrder(
      id,
      user.user_id,
      'admin',
    );
    return OrderMapper.toDto(order);
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
      'Datos inválidos (p. ej.: reason must be shorter than or equal to 500 characters)',
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
    @CurrentDistributor() distributorId: string | null,
  ) {
    await this.orderService.assertDeLaDistribuidora(id, distributorId);
    const order = await this.orderService.cancelOrder(
      id,
      user.user_id,
      mapRoleToCancelActor(user.role),
      body.reason,
    );
    return OrderMapper.toDto(order);
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
    @CurrentDistributor() distributorId: string | null,
  ) {
    await this.orderService.assertDeLaDistribuidora(id, distributorId);
    return this.orderService.notifyDriverArrived(id, user.user_id, user.role);
  }

  @Patch(':id/confirm-deposit')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Confirmar la seña de una reserva cobrada en efectivo',
    description:
      'Marca deposit_paid=true. Habilita la activación AUTOMÁTICA de la reserva ' +
      '(el cron la despacha el día agendado). La seña por MercadoPago se confirma ' +
      'sola vía webhook.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID (reserva)' })
  @ApiBadRequestResponse({
    description: 'El pedido no es una reserva pendiente',
  })
  @ApiNotFoundResponse({ description: 'Reserva no encontrada' })
  @ApiOkResponse({ type: OrderResponseDto, description: 'Seña confirmada' })
  async confirmDeposit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ) {
    const order = await this.reservationService.confirmDeposit(
      id,
      distributorId,
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
}
