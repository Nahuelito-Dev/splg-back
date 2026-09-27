import type { Response } from 'express';
import { ApiTotal, informarTotal } from '../common/http/total';
// delivery/delivery.controller.ts
import {
  Controller,
  ForbiddenException,
  Get,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  Res,
  ParseUUIDPipe,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiNotFoundResponse,
  ApiForbiddenResponse,
  ApiParam,
  ApiBearerAuth,
  ApiBadRequestResponse,
} from '@nestjs/swagger';
import { DeliveryService } from './delivery.service';
import { UpdateDeliveryLocationDto } from './dto/update-delivery-location.dto';
import { UpdateDeliveryBalanceDto } from './dto/update-delivery-balance.dto';
import { ToggleDeliveryStatusDto } from './dto/toggle-delivery-status.dto';
import { ToggleDeliveryAvailabilityDto } from './dto/toggle-delivery-availability.dto';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { UpdateDeliveryDto } from './dto/update-delivery.dto';
import { QueryDeliveryDto } from './dto/query-delivery.dto';
import { DeliveryResponseDto } from './dto/delivery-response.dto';
import { DisponibilidadDelChoferDto } from './dto/disponibilidad-response.dto';
import { DeliveryMapper } from './delivery.mapper';
import { MessageResponseDto } from '../common/dtos/message-response.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { alcanceDelDueño } from '../common/utils/alcance.util';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

@ApiTags('Delivery')
@ApiBearerAuth()
@Controller('delivery')
export class DeliveryController {
  constructor(private readonly deliveryService: DeliveryService) {}

  @Get()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Get all deliveries with pagination (scopeado por distribuidora)',
    description:
      '`term` busca por nombre, email o teléfono del chofer, y por la ' +
      'patente de su vehículo. `status` filtra por uno de los cuatro grupos ' +
      'administrativos (`enabled`/`disabled`/`online`/`unvalidated`); con ' +
      '`limit=1` y sin mirar el array, `X-Total-Count` da el total de cada uno.',
  })
  @ApiOkResponse({
    type: DeliveryResponseDto,
    isArray: true,
    description: 'List of deliveries',
  })
  @ApiTotal()
  async findAll(
    @Query() query: QueryDeliveryDto,
    @Res({ passthrough: true }) res: Response,
    @CurrentDistributor() distributorId?: string | null,
  ): Promise<DeliveryResponseDto[]> {
    const [deliveries, total] = await this.deliveryService.findAll(
      query,
      distributorId,
      query.status,
    );
    informarTotal(res, total);
    return deliveries.map((d) => DeliveryMapper.toDto(d));
  }

  // H-64: los choferes activos (con su ubicación) los ve un administrador, y el
  // de empresa sólo los de su distribuidora.
  @Get('active')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Get all active deliveries',
    description:
      '"Activo" significa en línea y listo para recibir pedidos: habilitado ' +
      '+ validado + conectado en su app (`isEnabled && validated && ' +
      'isAvailable`). `term` busca por nombre, email o teléfono del chofer, ' +
      'y por la patente de su vehículo.',
  })
  @ApiOkResponse({
    type: DeliveryResponseDto,
    isArray: true,
    description: 'List of active deliveries',
  })
  @ApiTotal()
  async findActive(
    @Query() paginationDto: PaginationDto,
    @Res({ passthrough: true }) res: Response,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<DeliveryResponseDto[]> {
    const [deliveries, total] = await this.deliveryService.findActiveDeliveries(
      paginationDto,
      distributorId,
    );
    informarTotal(res, total);
    return deliveries.map((d) => DeliveryMapper.toDto(d));
  }

  @Get(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY)
  @ApiOperation({ summary: 'Get delivery by ID' })
  @ApiParam({ name: 'id', description: 'Delivery UUID' })
  @ApiOkResponse({ type: DeliveryResponseDto, description: 'Delivery found' })
  @ApiNotFoundResponse({
    description: 'Delivery not found (o de otra distribuidora)',
  })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<DeliveryResponseDto> {
    const delivery = await this.deliveryService.findOne(id);
    this.deliveryService.assertAlcance(
      delivery,
      alcanceDelDueño(user),
      distributorId,
    );
    return DeliveryMapper.toDto(delivery);
  }

  @Get('user/:userId')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY)
  @ApiOperation({ summary: 'Get delivery by user ID' })
  @ApiParam({ name: 'userId', description: 'User UUID' })
  @ApiOkResponse({ type: DeliveryResponseDto, description: 'Delivery found' })
  @ApiNotFoundResponse({
    description: 'Delivery not found (o de otra distribuidora)',
  })
  async findOneByUserId(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<DeliveryResponseDto> {
    const delivery = await this.deliveryService.findOneByUserId(userId);
    this.deliveryService.assertAlcance(
      delivery,
      alcanceDelDueño(user),
      distributorId,
    );
    return DeliveryMapper.toDto(delivery);
  }

  @Patch(':id')
  // H-61: sólo un administrador edita a un chofer, y el de empresa sólo a los
  // de su distribuidora.
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Update delivery by ID' })
  @ApiParam({ name: 'id', description: 'Delivery UUID' })
  @ApiOkResponse({
    type: DeliveryResponseDto,
    description: 'Delivery updated successfully',
  })
  @ApiNotFoundResponse({
    description: 'Delivery not found (o de otra distribuidora)',
  })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: property calification should not exist; validated tiene que ser true o false)',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateDeliveryDto: UpdateDeliveryDto,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<DeliveryResponseDto> {
    return DeliveryMapper.toDto(
      await this.deliveryService.update(id, updateDeliveryDto, distributorId),
    );
  }

  @Patch(':id/validate')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Validate delivery' })
  @ApiParam({ name: 'id', description: 'Delivery UUID' })
  @ApiOkResponse({
    type: DeliveryResponseDto,
    description: 'Delivery validated successfully',
  })
  @ApiNotFoundResponse({
    description: 'Delivery not found (o de otra distribuidora)',
  })
  async validateDelivery(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<DeliveryResponseDto> {
    await this.acotar(id, distributorId);
    return DeliveryMapper.toDto(
      await this.deliveryService.validateDelivery(id),
    );
  }

  @Patch(':id/invalidate')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Invalidate delivery' })
  @ApiParam({ name: 'id', description: 'Delivery UUID' })
  @ApiOkResponse({
    type: DeliveryResponseDto,
    description: 'Delivery invalidated successfully',
  })
  @ApiNotFoundResponse({
    description: 'Delivery not found (o de otra distribuidora)',
  })
  async invalidateDelivery(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<DeliveryResponseDto> {
    await this.acotar(id, distributorId);
    return DeliveryMapper.toDto(
      await this.deliveryService.invalidateDelivery(id),
    );
  }

  // H-64: la ubicación la informa el propio chofer (o un admin).
  @Patch(':id/location')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY)
  @ApiOperation({ summary: 'Update delivery location' })
  @ApiParam({ name: 'id', description: 'Delivery UUID' })
  @ApiOkResponse({
    type: DeliveryResponseDto,
    description: 'Location updated successfully',
  })
  @ApiNotFoundResponse({
    description: 'Delivery not found (o de otra distribuidora)',
  })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: latLng debe ser "latitud,longitud", por ejemplo -27.3671,-55.8961)',
  })
  async updateLocation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDeliveryLocationDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<DeliveryResponseDto> {
    await this.acotar(id, distributorId);
    return DeliveryMapper.toDto(
      await this.deliveryService.updateLocation(
        id,
        dto.latLng,
        dto.actualLocation,
        alcanceDelDueño(user),
      ),
    );
  }

  @Patch(':id/balance')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Update delivery balance' })
  @ApiParam({ name: 'id', description: 'Delivery UUID' })
  @ApiOkResponse({
    type: DeliveryResponseDto,
    description: 'Balance updated successfully',
  })
  @ApiNotFoundResponse({
    description: 'Delivery not found (o de otra distribuidora)',
  })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: amount fuera de rango; amount fuera de rango)',
  })
  async updateBalance(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDeliveryBalanceDto,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<DeliveryResponseDto> {
    await this.acotar(id, distributorId);
    return DeliveryMapper.toDto(
      await this.deliveryService.updateBalance(id, dto.amount),
    );
  }

  @Patch(':id/status')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Habilita o deshabilita al chofer (admin)',
    description:
      'Cambia sólo la habilitación administrativa. Al deshabilitar, el ' +
      'chofer también se desconecta (`isAvailable: false`) y sale del radar ' +
      'de despacho: no puede volver a ponerse en línea desde su app hasta ' +
      'que un admin lo habilite de nuevo.',
  })
  @ApiParam({ name: 'id', description: 'Delivery UUID' })
  @ApiOkResponse({
    type: DeliveryResponseDto,
    description: 'Status updated successfully',
  })
  @ApiNotFoundResponse({
    description: 'Delivery not found (o de otra distribuidora)',
  })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: isEnabled tiene que ser true o false)',
  })
  async toggleStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ToggleDeliveryStatusDto,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<DeliveryResponseDto> {
    await this.acotar(id, distributorId);
    return DeliveryMapper.toDto(
      await this.deliveryService.toggleActiveStatus(id, dto.isEnabled),
    );
  }

  @Delete(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Delete delivery by ID (soft delete)' })
  @ApiParam({ name: 'id', description: 'Delivery UUID' })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiNotFoundResponse({
    description: 'Delivery not found (o de otra distribuidora)',
  })
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<MessageResponseDto> {
    await this.acotar(id, distributorId);
    return await this.deliveryService.remove(id);
  }

  // H-64: un chofer se pone disponible o no a sí mismo; un admin, a los de su
  // distribuidora.
  @Patch('user/:userId/availability')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY)
  @ApiOperation({
    summary: 'Toggle driver availability by User ID (ON/OFF)',
    description:
      'Ponerse EN LÍNEA (`available: true`) exige estar habilitado y ' +
      'validado; si no, responde 403. Desconectarse (`available: false`) ' +
      'siempre se permite.',
  })
  @ApiParam({ name: 'userId', description: 'User UUID' })
  @ApiOkResponse({ type: DisponibilidadDelChoferDto })
  @ApiForbiddenResponse({
    description:
      'Un chofer, sobre otro chofer; o intentando ponerse en línea estando ' +
      'deshabilitado o sin validar',
  })
  @ApiNotFoundResponse({
    description: 'No es chofer o es de otra distribuidora',
  })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: available tiene que ser true o false)',
  })
  async toggleAvailability(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ToggleDeliveryAvailabilityDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<DisponibilidadDelChoferDto> {
    const dueno = alcanceDelDueño(user);
    if (dueno && dueno !== userId) {
      throw new ForbiddenException(
        'No podés cambiar la disponibilidad de otro chofer',
      );
    }
    return this.deliveryService.toggleAvailability(
      userId,
      dto.available,
      dueno ? null : distributorId,
    );
  }

  /**
   * Aislamiento entre distribuidoras: con una en contexto, el chofer tiene que
   * ser de ella. Lo ajeno responde 404.
   */
  private async acotar(id: string, distributorId: string | null) {
    if (!distributorId) return;
    const delivery = await this.deliveryService.findOne(id);
    this.deliveryService.assertAlcance(delivery, null, distributorId);
  }
}
