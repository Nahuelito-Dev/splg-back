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
  HttpStatus,
  HttpCode,
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { OrderService } from './order.service';
import { ReservationService } from './application/reservation.service';
import { OrderMapper } from './order.mapper';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { ConfirmDeliveryDto } from './dto/confirm-delivery.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { Public } from '../common/decorators/isPublic.decorator';
import { OrderStatus } from './entities/order.entity';
import { withTransactionRetry } from '../common/utils/with-transaction-retry';
import { Idempotent } from '../common/decorators/idempotent.decorator';

import { ClassSerializerInterceptor, UseInterceptors } from '@nestjs/common';

/**
 * Traduce el rol autenticado (RoleType) al actor que espera
 * `OrderService.cancelOrder`. super_admin se trata como admin.
 */
function mapRoleToCancelActor(
  role: RoleType,
): 'customer' | 'driver' | 'admin' | 'superadmin' {
  switch (role) {
    case RoleType.CUSTOMER:
      return 'customer';
    case RoleType.DELIVERY:
      return 'driver';
    default:
      return 'admin';
  }
}

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
  @ApiResponse({ status: 201, description: 'Order created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({
    status: 409,
    description: 'Otro request con la misma Idempotency-Key está en curso',
  })
  async create(
    @Body() createOrderDto: CreateOrderDto,
    // Opcional para compatibilidad: si el cliente no manda X-Distributor (apps
    // previas al multi-tenant), el use-case cae a la distribuidora default.
    @CurrentDistributor() distributorId: string | null,
  ) {
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
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get all orders with pagination' })
  @ApiResponse({ status: 200, description: 'List of orders' })
  async findAll(
    @Query() paginationDto: PaginationDto,
    @CurrentDistributor() distributorId: string | null,
  ) {
    // Admin de distribuidora → sólo sus pedidos; super_admin sin header → todos.
    const result = await this.orderService.findAll(paginationDto, distributorId);
    return {
      ...result,
      orders: result.orders.map((order) => OrderMapper.toDto(order)),
    };
  }

  @Get('customer/:customerId')
  @Roles(
    RoleType.CUSTOMER,
    RoleType.DELIVERY,
    RoleType.ADMIN,
    RoleType.SUPER_ADMIN,
  )
  @ApiOperation({ summary: 'Get orders by customer ID' })
  @ApiParam({ name: 'customerId', description: 'Customer UUID' })
  @ApiResponse({ status: 200, description: 'List of customer orders' })
  async findByCustomer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query() paginationDto: PaginationDto,
    @CurrentDistributor() distributorId: string | null,
  ) {
    // Ownership: un cliente solo puede ver SUS pedidos. Admin ve los de cualquiera.
    // (order.customer_id es el User PK, igual que user.user_id.)
    if (user.role === RoleType.CUSTOMER && user.user_id !== customerId) {
      throw new ForbiddenException('No autorizado a ver pedidos de otro cliente');
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
  @Roles(RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get orders by delivery ID' })
  @ApiParam({ name: 'deliveryId', description: 'Delivery UUID' })
  @ApiResponse({ status: 200, description: 'List of delivery orders' })
  async findByDelivery(
    @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
    @Query() paginationDto: PaginationDto,
    @CurrentDistributor() distributorId: string | null,
  ) {
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
  @Roles(RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get available orders for delivery' })
  @ApiResponse({ status: 200, description: 'List of available orders' })
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

  @Get(':id')
  @ApiOperation({ summary: 'Get order by ID' })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiResponse({ status: 200, description: 'Order found' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ) {
    return await this.orderService.getOne(id, distributorId);
  }

  @Patch(':id/status')
  @Roles(RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @Idempotent()
  @ApiOperation({
    summary: 'Update order status',
    description:
      'Idempotente vía header `Idempotency-Key`. Evita doble aceptación/entrega por reintento de red. Solo chofer/admin.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiResponse({ status: 200, description: 'Status updated successfully' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async updateStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateOrderStatusDto,
  ) {
    // Un chofer solo puede operar EN SU NOMBRE: ignoramos cualquier deliveryId
    // del body y usamos su identidad autenticada (updateStatus resuelve el perfil
    // Delivery por user_id). El admin sí puede asignar a un chofer arbitrario.
    const isDriver = user.role === RoleType.DELIVERY;
    const deliveryId = isDriver ? user.user_id : body.deliveryId;

    const order = await this.orderService.updateStatus(
      id,
      body.status,
      deliveryId,
    );
    return OrderMapper.toDto(order);
  }

  @Get(':id/delivery-code')
  @Roles(RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Obtener el código secreto de entrega (para el QR del chofer)',
    description:
      'El chofer renderiza este código como QR y lo muestra al cliente al llegar. ' +
      'Solo existe si el pedido ya fue aceptado. El chofer solo puede ver el de SUS pedidos.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiResponse({ status: 200, description: 'Código de entrega' })
  @ApiResponse({ status: 400, description: 'El pedido aún no tiene código (no aceptado)' })
  @ApiResponse({ status: 403, description: 'El pedido no está asignado a este chofer' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async getDeliveryCode(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orderService.getDeliveryCode(id, user.user_id, user.role);
  }

  @Post(':id/confirm-delivery')
  @Roles(RoleType.CUSTOMER, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @Idempotent()
  @ApiOperation({
    summary: 'Confirmar entrega escaneando el QR del chofer (prueba anti-fraude)',
    description:
      'El cliente escanea el QR que muestra el chofer y envía el código leído. ' +
      'Si coincide con `order.deliveryCode` y el pedido está ON_THE_WAY, se marca DELIVERED. ' +
      'Idempotente vía header `Idempotency-Key`: reintentos de red no re-procesan la entrega.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiResponse({ status: 200, description: 'Entrega confirmada' })
  @ApiResponse({ status: 400, description: 'Código inválido o el pedido no está en camino' })
  @ApiResponse({ status: 403, description: 'No autorizado (pedido de otro cliente)' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async confirmDelivery(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ConfirmDeliveryDto,
  ) {
    const order = await this.orderService.confirmDelivery(
      id,
      body.code,
      user.user_id,
      user.role,
    );
    return OrderMapper.toDto(order);
  }

  @Patch(':id/assign/:deliveryId')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Assign order to delivery' })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiParam({ name: 'deliveryId', description: 'Delivery UUID' })
  @ApiResponse({ status: 200, description: 'Order assigned successfully' })
  @ApiResponse({ status: 404, description: 'Order or delivery not found' })
  async assignDelivery(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
  ) {
    const order = await this.orderService.assignDelivery(id, deliveryId);
    return OrderMapper.toDto(order);
  }

  @Patch(':id/location')
  @Roles(RoleType.DELIVERY)
  @ApiOperation({ summary: 'Update delivery location' })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiResponse({ status: 200, description: 'Location updated successfully' })
  async updateLocation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { lat: string; lng: string },
  ) {
    const order = await this.orderService.updateLocation(
      id,
      body.lat,
      body.lng,
    );
    return OrderMapper.toDto(order);
  }

  @Get('stats/summary')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get order statistics' })
  @ApiResponse({ status: 200, description: 'Statistics retrieved' })
  async getStats() {
    return await this.orderService.getOrderStats();
  }

  @Delete(':id')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Cancel order (Admin Force)' })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiResponse({ status: 200, description: 'Order cancelled successfully' })
  async cancelOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    // Cancelación forzada por admin. La identidad sale del token, no de un id
    // ficticio hardcodeado.
    const order = await this.orderService.cancelOrder(id, user.user_id, 'admin');
    return OrderMapper.toDto(order);
  }

  @Patch(':id/cancel')
  @Roles(RoleType.CUSTOMER, RoleType.DELIVERY, RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @Idempotent()
  @ApiOperation({
    summary: 'Cancelar pedido (Cliente/Chofer/Admin)',
    description:
      'Idempotente vía header `Idempotency-Key`. Cancelaciones repetidas con la misma key son no-op. El actor (id + rol) sale SIEMPRE del token autenticado, nunca del body (evita IDOR).',
  })
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { reason?: string },
  ) {
    const order = await this.orderService.cancelOrder(
      id,
      user.user_id,
      mapRoleToCancelActor(user.role),
      body.reason,
    );
    return OrderMapper.toDto(order);
  }

  @Patch(':id/arrived')
  async notifyArrival(@Param('id') id: string) {
    return this.orderService.notifyDriverArrived(id);
  }

  @Patch(':id/confirm-deposit')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Confirmar la seña de una reserva cobrada en efectivo',
    description:
      'Marca deposit_paid=true. Habilita la activación AUTOMÁTICA de la reserva ' +
      '(el cron la despacha el día agendado). La seña por MercadoPago se confirma ' +
      'sola vía webhook.',
  })
  @ApiParam({ name: 'id', description: 'Order UUID (reserva)' })
  async confirmDeposit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ) {
    const order = await this.reservationService.confirmDeposit(id, distributorId);
    return OrderMapper.toDto(order);
  }

  @Get('stats/chart')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get sales chart data (Last 7 days)' })
  async getChartData() {
    return await this.orderService.getSalesChartData();
  }
}
