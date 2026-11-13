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
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { FleetPlanService } from './fleet-plan.service';
import { FleetPlanMapper } from './fleet-plan.mapper';
import { CreateFleetPlanDto } from './dto/create-plan.dto';
import { UpdateFleetPlanDto } from './dto/update-plan.dto';
import { QueryFleetPlanDto } from './dto/query-plan.dto';
import { FleetPlanResponseDto } from './dto/plan-response.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { Permiso } from '../common/decorators/permiso.decorator';

/**
 * Planes de mantenimiento/habilitación de la flota (CU-136 a CU-142): la
 * REGLA. Toda distribuidora arranca con 4 (seguro, VTV, licencia, service);
 * este CRUD es para ajustarlos o agregar los propios.
 *
 * La "baja" de un plan es `PATCH { isActive: false }`, no un DELETE: un plan
 * con tareas creadas no se puede borrar (integridad referencial), y
 * desactivarlo alcanza para dejar de usarlo hacia adelante.
 */
@ApiTags('Fleet · Plans')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('fleet/plans')
export class FleetPlanController {
  constructor(private readonly plans: FleetPlanService) {}

  @Permiso('flota.gestionar')
  @Post()
  @ApiOperation({ summary: 'Crear un plan de mantenimiento/habilitación' })
  @ApiCreatedResponse({ type: FleetPlanResponseDto })
  @ApiBadRequestResponse({
    description:
      'Falta la distribuidora, o el intervalo no es coherente con el trigger',
  })
  async create(
    @Body() dto: CreateFleetPlanDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FleetPlanResponseDto> {
    return FleetPlanMapper.toDto(await this.plans.create(dto, distributorId));
  }

  @Permiso('flota.ver')
  @Get()
  @ApiOperation({ summary: 'Listar los planes de la distribuidora' })
  @ApiOkResponse({ type: FleetPlanResponseDto, isArray: true })
  async findAll(
    @Query() query: QueryFleetPlanDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FleetPlanResponseDto[]> {
    const plans = await this.plans.findAll(distributorId, query);
    return plans.map((p) => FleetPlanMapper.toDto(p));
  }

  @Permiso('flota.ver')
  @Get(':id')
  @ApiOperation({ summary: 'Ver un plan' })
  @ApiParam({ name: 'id', description: 'Plan UUID' })
  @ApiOkResponse({ type: FleetPlanResponseDto })
  @ApiNotFoundResponse({ description: 'Plan no encontrado' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FleetPlanResponseDto> {
    return FleetPlanMapper.toDto(await this.plans.findOne(id, distributorId));
  }

  @Permiso('flota.gestionar')
  @Patch(':id')
  @ApiOperation({
    summary: 'Editar un plan (o desactivarlo con isActive: false)',
  })
  @ApiParam({ name: 'id', description: 'Plan UUID' })
  @ApiOkResponse({ type: FleetPlanResponseDto })
  @ApiNotFoundResponse({ description: 'Plan no encontrado' })
  @ApiBadRequestResponse({
    description: 'El intervalo no es coherente con el trigger',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFleetPlanDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FleetPlanResponseDto> {
    return FleetPlanMapper.toDto(
      await this.plans.update(id, dto, distributorId),
    );
  }
}
