// delivery/delivery.controller.ts
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
import { DeliveryService } from './delivery.service';
import { CreateDeliveryDto } from './dto/create-delivery.dto';
import { UpdateDeliveryDto } from './dto/update-delivery.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { Public } from '../common/decorators/isPublic.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/decorators/roles.guard';
import { RoleType } from '../common/constants/role-type.enum';
import { AuthGuard } from 'src/auth/guards/jwt-auth.guard'; // <--- IMPORTANTE: Importar AuthGuard


@ApiTags('Delivery')
@ApiBearerAuth()
@Controller('delivery')
export class DeliveryController {
  constructor(private readonly deliveryService: DeliveryService) {}

  @Get()
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN) // ← Usar RoleType enum
  @ApiOperation({ summary: 'Get all deliveries with pagination' })
  @ApiResponse({ status: 200, description: 'List of deliveries' })
  async findAll(@Query() paginationDto: PaginationDto) {
    return await this.deliveryService.findAll(paginationDto);
  }

  @Get('active')
  @ApiOperation({ summary: 'Get all active deliveries' })
  @ApiResponse({ status: 200, description: 'List of active deliveries' })
  async findActive(@Query() paginationDto: PaginationDto) {
    return await this.deliveryService.findActiveDeliveries(paginationDto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get delivery by ID' })
  @ApiParam({ name: 'id', description: 'Delivery UUID' })
  @ApiResponse({ status: 200, description: 'Delivery found' })
  @ApiResponse({ status: 404, description: 'Delivery not found' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return await this.deliveryService.findOne(id);
  }

  @Get('user/:userId')
  @ApiOperation({ summary: 'Get delivery by user ID' })
  @ApiParam({ name: 'userId', description: 'User UUID' })
  @ApiResponse({ status: 200, description: 'Delivery found' })
  @ApiResponse({ status: 404, description: 'Delivery not found' })
  async findOneByUserId(@Param('userId', ParseUUIDPipe) userId: string) {
    return await this.deliveryService.findOneByUserId(userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update delivery by ID' })
  @ApiParam({ name: 'id', description: 'Delivery UUID' })
  @ApiResponse({ status: 200, description: 'Delivery updated successfully' })
  @ApiResponse({ status: 404, description: 'Delivery not found' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateDeliveryDto: UpdateDeliveryDto,
  ) {
    return await this.deliveryService.update(id, updateDeliveryDto);
  }

  @Patch(':id/validate')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN) // ← Usar RoleType enum
  @ApiOperation({ summary: 'Validate delivery' })
  @ApiParam({ name: 'id', description: 'Delivery UUID' })
  @ApiResponse({ status: 200, description: 'Delivery validated successfully' })
  @ApiResponse({ status: 404, description: 'Delivery not found' })
  async validateDelivery(@Param('id', ParseUUIDPipe) id: string) {
    return await this.deliveryService.validateDelivery(id);
  }

  @Patch(':id/invalidate')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN) // ← Usar RoleType enum
  @ApiOperation({ summary: 'Invalidate delivery' })
  @ApiParam({ name: 'id', description: 'Delivery UUID' })
  @ApiResponse({
    status: 200,
    description: 'Delivery invalidated successfully',
  })
  @ApiResponse({ status: 404, description: 'Delivery not found' })
  async invalidateDelivery(@Param('id', ParseUUIDPipe) id: string) {
    return await this.deliveryService.invalidateDelivery(id);
  }

  @Patch(':id/location')
  @ApiOperation({ summary: 'Update delivery location' })
  @ApiParam({ name: 'id', description: 'Delivery UUID' })
  @ApiResponse({ status: 200, description: 'Location updated successfully' })
  @ApiResponse({ status: 404, description: 'Delivery not found' })
  async updateLocation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { latLng: string; actualLocation?: string },
  ) {
    return await this.deliveryService.updateLocation(
      id,
      body.latLng,
      body.actualLocation,
    );
  }

  @Patch(':id/balance')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN) // ← Usar RoleType enum
  @ApiOperation({ summary: 'Update delivery balance' })
  @ApiParam({ name: 'id', description: 'Delivery UUID' })
  @ApiResponse({ status: 200, description: 'Balance updated successfully' })
  @ApiResponse({ status: 404, description: 'Delivery not found' })
  async updateBalance(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { amount: number },
  ) {
    return await this.deliveryService.updateBalance(id, body.amount);
  }

  @Patch(':id/status')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN) // ← Usar RoleType enum
  @ApiOperation({ summary: 'Toggle delivery active status' })
  @ApiParam({ name: 'id', description: 'Delivery UUID' })
  @ApiResponse({ status: 200, description: 'Status updated successfully' })
  @ApiResponse({ status: 404, description: 'Delivery not found' })
  async toggleStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { isActive: boolean },
  ) {
    return await this.deliveryService.toggleActiveStatus(id, body.isActive);
  }

  @Delete(':id')
  @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN) // ← Usar RoleType enum
  @ApiOperation({ summary: 'Delete delivery by ID (soft delete)' })
  @ApiParam({ name: 'id', description: 'Delivery UUID' })
  @ApiResponse({ status: 200, description: 'Delivery deleted successfully' })
  @ApiResponse({ status: 404, description: 'Delivery not found' })
  @HttpCode(HttpStatus.OK)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    return await this.deliveryService.remove(id);
  }

  @Patch('user/:userId/availability') // <--- CAMBIO: Ruta más clara
  @ApiOperation({ summary: 'Toggle driver availability by User ID (ON/OFF)' })
  @ApiParam({ name: 'userId', description: 'User UUID' }) // <--- CAMBIO: Documentación
  async toggleAvailability(
    @Param('userId', ParseUUIDPipe) userId: string, // <--- CAMBIO: Recibimos userId
    @Body() body: { available: boolean },
  ) {
    return this.deliveryService.toggleAvailability(userId, body.available);
  }
}
