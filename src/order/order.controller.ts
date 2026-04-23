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
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { OrderService } from './order.service';
import { OrderMapper } from './order.mapper';
import { CreateOrderDto } from './dto/create-order.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { AuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { Public } from '../common/decorators/isPublic.decorator';
import { OrderStatus } from './entities/order.entity';

import { ClassSerializerInterceptor, UseInterceptors } from '@nestjs/common';

@ApiTags('Orders')
@ApiBearerAuth()
@UseInterceptors(ClassSerializerInterceptor)
@Controller('orders')
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new order' })
  @ApiResponse({ status: 201, description: 'Order created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  async create(@Body() createOrderDto: CreateOrderDto) {
    const order = await this.orderService.create(createOrderDto);
    return OrderMapper.toDto(order);
  }

  @Get()
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get all orders with pagination' })
  @ApiResponse({ status: 200, description: 'List of orders' })
  async findAll(@Query() paginationDto: PaginationDto) {
    const result = await this.orderService.findAll(paginationDto);
    return {
      ...result,
      orders: result.orders.map((order) => OrderMapper.toDto(order)),
    };
  }

  @Get('customer/:customerId')
  @ApiOperation({ summary: 'Get orders by customer ID' })
  @ApiParam({ name: 'customerId', description: 'Customer UUID' })
  @ApiResponse({ status: 200, description: 'List of customer orders' })
  async findByCustomer(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query() paginationDto: PaginationDto,
  ) {
    const result = await this.orderService.findByCustomer(
      customerId,
      paginationDto,
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
  ) {
    const result = await this.orderService.findByDelivery(
      deliveryId,
      paginationDto,
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
  async findAvailableOrders(@Query() paginationDto: PaginationDto) {
    const result = await this.orderService.findAvailableOrders(paginationDto);
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
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return await this.orderService.getOne(id);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Update order status' })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiResponse({ status: 200, description: 'Status updated successfully' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { status: OrderStatus; deliveryId?: string },
  ) {
    const order = await this.orderService.updateStatus(
      id,
      body.status,
      body.deliveryId,
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
  @ApiOperation({ summary: 'Cancel order (Admin Force)' })
  @ApiParam({ name: 'id', description: 'Order UUID' })
  @ApiResponse({ status: 200, description: 'Order cancelled successfully' })
  async cancelOrder(@Param('id', ParseUUIDPipe) id: string) {
    // Como es un DELETE directo, asumimos que es un ADMIN o el SISTEMA
    // Pasamos un ID ficticio 'SYSTEM_ADMIN' y el rol 'admin'
    const order = await this.orderService.cancelOrder(
      id,
      'SYSTEM_ADMIN',
      'admin',
    );
    return OrderMapper.toDto(order);
  }

  // 🟢 ESTE ES TU NUEVO ENDPOINT (Lógica Fina)
  @Patch(':id/cancel')
  @ApiOperation({ summary: 'Cancelar pedido (Cliente/Chofer)' })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    // 👇 Agregamos 'reason' al Body
    @Body()
    body: { userId: string; role: 'customer' | 'driver'; reason?: string },
  ) {
    const order = await this.orderService.cancelOrder(
      id,
      body.userId,
      body.role,
      body.reason,
    );
    return OrderMapper.toDto(order);
  }

  @Patch(':id/arrived')
  async notifyArrival(@Param('id') id: string) {
    return this.orderService.notifyDriverArrived(id);
  }

  @Get('stats/chart')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get sales chart data (Last 7 days)' })
  async getChartData() {
    return await this.orderService.getSalesChartData();
  }
}
