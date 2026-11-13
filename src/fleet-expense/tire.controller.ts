import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { RoleType } from '../common/constants/role-type.enum';
import { Auth } from '../common/decorators/auth.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import {
  CreateTireDto,
  CreateTireEventDto,
  QueryTireDto,
  TireEventResponseDto,
  TirePageDto,
  TireResponseDto,
} from './dto/tire.dto';
import { FleetExpenseMapper } from './fleet-expense.mapper';
import { TireService } from './tire.service';
import { Permiso } from '../common/decorators/permiso.decorator';

export class TireMovementResponseDto {
  @ApiProperty({ type: TireEventResponseDto }) event!: TireEventResponseDto;
  @ApiProperty({
    type: TireResponseDto,
    description: 'El neumático ya en su estado nuevo',
  })
  tire!: TireResponseDto;
}

/** Neumáticos y sus movimientos (CU-205, CU-206). Opcional dentro del módulo de flota ampliada. */
@ApiTags('Fleet · Neumáticos')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('fleet/tires')
export class TireController {
  constructor(private readonly tires: TireService) {}

  @Permiso('flota.gestionar')
  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Registrar un neumático',
    description: 'Nace en depósito, sin vehículo ni posición.',
  })
  @ApiCreatedResponse({ type: TireResponseDto })
  @ApiBadRequestResponse({
    description: 'Dato obligatorio faltante o costo negativo',
  })
  @ApiConflictResponse({
    description: 'El neumático ya está registrado (número de serie)',
  })
  async create(
    @Body() dto: CreateTireDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TireResponseDto> {
    return FleetExpenseMapper.tire(
      await this.tires.registrar(dto, distributorId),
    );
  }

  @Permiso('flota.ver')
  @Get()
  @ApiOperation({ summary: 'Listar los neumáticos' })
  @ApiOkResponse({ type: TirePageDto })
  async findAll(
    @Query() query: QueryTireDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TirePageDto> {
    const { data, total } = await this.tires.findAll(distributorId, query);
    return { data: data.map((t) => FleetExpenseMapper.tire(t)), total };
  }

  @Permiso('flota.ver')
  @Get(':id')
  @ApiOperation({ summary: 'Ver un neumático con su historial de movimientos' })
  @ApiParam({ name: 'id', description: 'Neumático UUID' })
  @ApiOkResponse({ type: TireResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TireResponseDto> {
    const neumatico = await this.tires.findOne(id, distributorId);
    const eventos = await this.tires.historial(id, distributorId);
    return FleetExpenseMapper.tire(neumatico, eventos);
  }

  @Permiso('flota.gestionar')
  @Post(':id/events')
  @Idempotent()
  @ApiOperation({
    summary: 'Registrar un movimiento de un neumático',
    description:
      'Montaje (carId y position), desmontaje, rotación (position nueva), recapado o baja definitiva, siempre con el kilometraje del vehículo. El movimiento es un asiento que no se modifica.',
  })
  @ApiParam({ name: 'id', description: 'Neumático UUID' })
  @ApiCreatedResponse({ type: TireMovementResponseDto })
  @ApiBadRequestResponse({
    description:
      'Falta el vehículo o la posición, o el kilometraje es menor que el del montaje',
  })
  @ApiNotFoundResponse({
    description:
      'El neumático o el vehículo no existen o son de otra distribuidora',
  })
  @ApiConflictResponse({
    description:
      'Movimiento inválido para el estado del neumático, o posición ocupada',
  })
  async registerEvent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateTireEventDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<TireMovementResponseDto> {
    const { tire, event } = await this.tires.registrarMovimiento(
      id,
      dto,
      distributorId,
      userId,
    );
    return {
      event: FleetExpenseMapper.tireEvent(event),
      tire: FleetExpenseMapper.tire(tire),
    };
  }
}
