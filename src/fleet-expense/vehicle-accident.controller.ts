import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import {
  CloseVehicleAccidentDto,
  CreateMyVehicleAccidentDto,
  CreateVehicleAccidentDto,
  QueryVehicleAccidentDto,
  UpdateVehicleAccidentDto,
  VehicleAccidentCreatedDto,
  VehicleAccidentPageDto,
  VehicleAccidentResponseDto,
} from './dto/vehicle-accident.dto';
import { FleetExpenseMapper } from './fleet-expense.mapper';
import { VehicleAccidentService } from './vehicle-accident.service';
import { Permiso } from '../common/decorators/permiso.decorator';

/** Siniestros de la flota (CU-201, CU-202, CU-327, CU-328). */
@ApiTags('Fleet · Siniestros')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('fleet/accidents')
export class VehicleAccidentController {
  constructor(private readonly accidents: VehicleAccidentService) {}

  @Permiso('flota.gestionar')
  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Registrar un siniestro (administrador)',
    description:
      'Nace denunciado y se registra siempre. Con `vehicleUnusable` el vehículo pasa a fuera de servicio y se libera a su chofer; si el chofer tiene un pedido en curso o una carga de camión abierta la asignación se mantiene (`assignmentKept: true` y el motivo) y se avisa a los administradores. Con `hazmatRelease` se avisa de inmediato a los administradores.',
  })
  @ApiCreatedResponse({ type: VehicleAccidentCreatedDto })
  @ApiBadRequestResponse({
    description: 'Falta la fecha o la descripción, o el punto no es válido',
  })
  @ApiNotFoundResponse({ description: 'Vehículo o empleado no encontrado' })
  async create(
    @Body() dto: CreateVehicleAccidentDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<VehicleAccidentCreatedDto> {
    return FleetExpenseMapper.siniestroRegistrado(
      await this.accidents.registrar(dto, distributorId, userId),
    );
  }

  @Post('mine')
  @Idempotent()
  @Permiso('flota.gestionar')
  @Auth(RoleType.DELIVERY)
  @ApiOperation({
    summary: 'Registrar un siniestro (chofer)',
    description: 'Siempre del vehículo que el chofer tiene en uso.',
  })
  @ApiCreatedResponse({ type: VehicleAccidentCreatedDto })
  @ApiBadRequestResponse({
    description: 'Falta la fecha o la descripción, o el punto no es válido',
  })
  @ApiNotFoundResponse({ description: 'No tenés un vehículo en uso' })
  async createMine(
    @Body() dto: CreateMyVehicleAccidentDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<VehicleAccidentCreatedDto> {
    return FleetExpenseMapper.siniestroRegistrado(
      await this.accidents.registrarPropio(dto, distributorId, userId),
    );
  }

  @Permiso('flota.ver')
  @Get()
  @ApiOperation({ summary: 'Consultar los siniestros' })
  @ApiOkResponse({ type: VehicleAccidentPageDto })
  @ApiBadRequestResponse({ description: 'Filtro inválido' })
  async findAll(
    @Query() query: QueryVehicleAccidentDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<VehicleAccidentPageDto> {
    const { data, total } = await this.accidents.findAll(distributorId, query);
    return {
      data: data.map((s) => FleetExpenseMapper.vehicleAccident(s)),
      total,
    };
  }

  @Permiso('flota.ver')
  @Get(':id')
  @ApiOperation({ summary: 'Ver un siniestro' })
  @ApiParam({ name: 'id', description: 'Siniestro UUID' })
  @ApiOkResponse({ type: VehicleAccidentResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<VehicleAccidentResponseDto> {
    return FleetExpenseMapper.vehicleAccident(
      await this.accidents.findOne(id, distributorId),
    );
  }

  @Permiso('flota.gestionar')
  @Patch(':id')
  @ApiOperation({
    summary: 'Modificar un siniestro o avanzar su estado',
    description:
      'El estado sólo avanza al siguiente del ciclo: denunciado, en revisión, en reparación. El cierre es `PATCH …/close`. No devuelve el vehículo a la flota (eso es `POST /car/:id/reactivate`).',
  })
  @ApiParam({ name: 'id', description: 'Siniestro UUID' })
  @ApiOkResponse({ type: VehicleAccidentResponseDto })
  @ApiBadRequestResponse({ description: 'Dato inválido' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({
    description: 'Está cerrado, o el cambio de estado no respeta el ciclo',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVehicleAccidentDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<VehicleAccidentResponseDto> {
    return FleetExpenseMapper.vehicleAccident(
      await this.accidents.modificar(id, dto, distributorId),
    );
  }

  @Permiso('flota.gestionar')
  @Patch(':id/close')
  @ApiOperation({
    summary: 'Cerrar un siniestro',
    description:
      'Asienta el costo de la reparación, el reintegro del seguro y la franquicia. Su costo neto entra en el costo del vehículo. No reactiva el vehículo.',
  })
  @ApiParam({ name: 'id', description: 'Siniestro UUID' })
  @ApiOkResponse({ type: VehicleAccidentResponseDto })
  @ApiBadRequestResponse({ description: 'Algún importe es negativo' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({ description: 'El siniestro ya está cerrado' })
  async close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseVehicleAccidentDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<VehicleAccidentResponseDto> {
    return FleetExpenseMapper.vehicleAccident(
      await this.accidents.cerrar(id, dto, distributorId),
    );
  }
}
