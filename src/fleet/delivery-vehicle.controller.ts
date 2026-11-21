import type { Response } from 'express';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { VehicleAssignmentService } from '../car/vehicle-assignment.service';
import { FleetTaskService } from './fleet-task.service';
import { VehicleAssignmentMapper } from './vehicle-assignment.mapper';
import { AssignVehicleDto } from './dto/assign-vehicle.dto';
import {
  VehicleAssignmentHistoryResponseDto,
  VehicleInUseResponseDto,
} from './dto/vehicle-assignment-response.dto';
import { CarPhotoService } from '../car/car-photo.service';
import { DeliveryService } from '../delivery/delivery.service';
import { MessageResponseDto } from '../common/dtos/message-response.dto';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { ApiTotal, informarTotal } from '../common/http/total';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { Permiso } from '../common/decorators/permiso.decorator';

/**
 * Qué vehículo usa cada chofer (decisión de nahue del 30/09): vive en
 * `fleet` (no en `car` ni en `delivery`) por el mismo motivo que
 * `CarDocumentsController`/`DeliveryDocumentsController` — la ruta HTTP no
 * depende de en qué módulo de Nest se declara el controller, y acá hace
 * falta `FleetTaskService` (para rechazar un vehículo inhabilitado) además
 * de `VehicleAssignmentService` (de `car`).
 */
@ApiTags('Fleet · Vehicle in use')
@Controller('delivery')
export class DeliveryVehicleController {
  constructor(
    private readonly vehicleAssignments: VehicleAssignmentService,
    private readonly fleetTasks: FleetTaskService,
    private readonly deliveryService: DeliveryService,
    private readonly fotosDeVehiculos: CarPhotoService,
  ) {}

  // Declarado ANTES de `:id/vehicle`: si no, `:id` matchea "me" como si
  // fuera un deliveryId y esta ruta nunca se alcanza.
  @Get('me/vehicle')
  @Auth(RoleType.DELIVERY)
  @ApiOperation({ summary: 'El vehículo en uso del chofer autenticado' })
  @ApiOkResponse({
    type: VehicleInUseResponseDto,
    description: 'Sin cuerpo si no tiene ningún vehículo en uso',
  })
  async miVehiculo(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<VehicleInUseResponseDto | null> {
    const delivery = await this.deliveryService.findOneByUserId(user.user_id);
    return this.obtenerVehiculoEnUso(delivery.deliveryId, distributorId);
  }

  @Get(':id/vehicle')
  @ApiBadRequestResponse({
    description: 'El id no es un UUID o super admin sin X-Distributor',
  })
  @Permiso('flota.ver')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Vehículo en uso de un chofer' })
  @ApiParam({ name: 'id', description: 'Delivery UUID' })
  @ApiOkResponse({
    type: VehicleInUseResponseDto,
    description: 'Sin cuerpo si no tiene ningún vehículo en uso',
  })
  @ApiNotFoundResponse({ description: 'Chofer no encontrado' })
  async vehiculoDelChofer(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<VehicleInUseResponseDto | null> {
    return this.obtenerVehiculoEnUso(id, distributorId);
  }

  @Put(':id/vehicle')
  @Permiso('flota.gestionar')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Poner en uso un vehículo para un chofer',
    description:
      'La flota es de la distribuidora: cualquier chofer puede usar ' +
      'cualquiera de sus vehículos. Cierra la asignación abierta anterior ' +
      'del chofer (si tenía otro vehículo) y la del vehículo (si lo tenía ' +
      'otro chofer). Rechaza un vehículo inhabilitado por documentación ' +
      'vencida (CU-136/137).',
  })
  @ApiParam({ name: 'id', description: 'Delivery UUID' })
  @ApiOkResponse({ type: VehicleInUseResponseDto })
  @ApiNotFoundResponse({ description: 'Chofer o vehículo no encontrado' })
  @ApiBadRequestResponse({
    description:
      'El vehículo está inhabilitado por documentación vencida, datos inválidos, o super admin sin X-Distributor',
  })
  @ApiConflictResponse({
    description:
      'El chofer (o a quien se le "roba" el vehículo) tiene un pedido en curso',
  })
  async ponerEnUso(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignVehicleDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<VehicleInUseResponseDto> {
    // La pertenencia del chofer al tenant corta PRIMERO (404, sin revelar
    // nada de flota de un chofer ajeno). El chequeo de flota vive en `fleet`
    // (este módulo): `car` no puede depender de `fleet` sin generar un ciclo
    // (CONVENCIONES §4).
    await this.vehicleAssignments.assertChoferDelTenant(id, distributorId);
    await this.fleetTasks.assertVehiculoHabilitado(dto.carId, distributorId);
    const asignacion = await this.vehicleAssignments.ponerEnUso(
      id,
      dto.carId,
      dto.note ?? null,
      distributorId,
      user.user_id,
    );
    // Se arma del resultado de `ponerEnUso` (que ya trae `car`), no de otra
    // lectura: `vehiculoEnUso` podría, en una carrera rarísima, haber
    // cambiado entre el alta y la lectura. El vehículo recién pasó el gate
    // de flota (arriba, en esta misma request): no hace falta otra consulta
    // para `isLocked`.
    await this.fotosDeVehiculos.firmar(asignacion.car);
    return VehicleAssignmentMapper.toVehicleInUseDto(asignacion, false);
  }

  @Delete(':id/vehicle')
  @ApiBadRequestResponse({
    description: 'El id no es un UUID o super admin sin X-Distributor',
  })
  @Permiso('flota.gestionar')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Liberar el vehículo en uso de un chofer' })
  @ApiParam({ name: 'id', description: 'Delivery UUID' })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiNotFoundResponse({
    description: 'Chofer no encontrado, o no tiene un vehículo en uso',
  })
  @ApiConflictResponse({
    description: 'El chofer tiene un pedido en curso (aceptado o en camino)',
  })
  async liberar(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<MessageResponseDto> {
    await this.vehicleAssignments.liberar(id, distributorId, user.user_id);
    return MessageResponseDto.of('Vehículo liberado');
  }

  @Get(':id/vehicle-history')
  @ApiBadRequestResponse({
    description:
      'El id no es un UUID, paginación inválida, o super admin sin X-Distributor',
  })
  @Permiso('flota.ver')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Historial de vehículos de un chofer' })
  @ApiParam({ name: 'id', description: 'Delivery UUID' })
  @ApiOkResponse({
    type: VehicleAssignmentHistoryResponseDto,
    isArray: true,
  })
  @ApiNotFoundResponse({ description: 'Chofer no encontrado' })
  @ApiTotal()
  async historial(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() pagination: PaginationDto,
    @Res({ passthrough: true }) res: Response,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<VehicleAssignmentHistoryResponseDto[]> {
    const [filas, total] = await this.vehicleAssignments.historialDelChofer(
      id,
      distributorId,
      pagination,
    );
    informarTotal(res, total);
    await this.fotosDeVehiculos.firmar(filas.map((f) => f.car));
    return filas.map((f) => VehicleAssignmentMapper.toHistoryDto(f));
  }

  private async obtenerVehiculoEnUso(
    deliveryId: string,
    distributorId: string,
  ): Promise<VehicleInUseResponseDto | null> {
    const asignacion = await this.vehicleAssignments.vehiculoEnUso(
      deliveryId,
      distributorId,
    );
    if (!asignacion) return null;
    await this.fotosDeVehiculos.firmar(asignacion.car);

    const motivos = await this.fleetTasks.motivosDeInhabilitacionDeVehiculo(
      asignacion.carId,
      distributorId,
    );
    return VehicleAssignmentMapper.toVehicleInUseDto(
      asignacion,
      motivos.length > 0,
    );
  }
}
