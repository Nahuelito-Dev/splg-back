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
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { CommissionRuleService } from '../application/commission-rule.service';
import {
  CommissionRulePageDto,
  CommissionRuleResponseDto,
  CreateCommissionRuleDto,
  QueryCommissionRuleDto,
  UpdateCommissionRuleDto,
} from '../dto/commission.dto';
import { CommissionMapper } from './commission.mapper';
import { Permiso } from '../../common/decorators/permiso.decorator';

/** Reglas de comisión por entrega (CU-240, CU-333). */
@ApiTags('Comisiones · Reglas')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('commission-rules')
export class CommissionRuleController {
  constructor(private readonly reglas: CommissionRuleService) {}

  @Permiso('finanzas.ver')
  @Get()
  @ApiOperation({ summary: 'Listar las reglas de comisión' })
  @ApiOkResponse({ type: CommissionRulePageDto })
  async findAll(
    @Query() query: QueryCommissionRuleDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CommissionRulePageDto> {
    const { data, total } = await this.reglas.findAll(distributorId, query);
    return { data: data.map((r) => CommissionMapper.regla(r)), total };
  }

  @Permiso('finanzas.gestionar')
  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Crear una regla de comisión por entrega',
    description:
      'Alcance: un chofer (o todos) y un producto (o todos). Precedencia al devengar: chofer y producto > chofer > producto > general. Para cambiar el valor hacia adelante conviene cerrar la regla vigente (`validTo`) y crear otra: modificar una regla no recalcula nada hacia atrás.',
  })
  @ApiCreatedResponse({ type: CommissionRuleResponseDto })
  @ApiBadRequestResponse({
    description:
      'Base inválida, valor negativo, porcentaje mayor a 100 o vigencia al revés',
  })
  @ApiNotFoundResponse({
    description:
      'El empleado o el producto no existen o son de otra distribuidora',
  })
  @ApiConflictResponse({
    description: 'Se solapa con otra regla vigente del mismo alcance',
  })
  async create(
    @Body() dto: CreateCommissionRuleDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CommissionRuleResponseDto> {
    return CommissionMapper.regla(await this.reglas.create(dto, distributorId));
  }

  @Permiso('finanzas.gestionar')
  @Patch(':id')
  @Idempotent()
  @ApiOperation({
    summary: 'Modificar una regla de comisión',
    description:
      'No recalcula los asientos ya devengados: cada uno guarda la regla con que se calculó.',
  })
  @ApiParam({ name: 'id', description: 'Regla UUID' })
  @ApiOkResponse({ type: CommissionRuleResponseDto })
  @ApiBadRequestResponse({ description: 'Base, valor o vigencia inválidos' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiConflictResponse({
    description: 'Queda solapada con otra regla vigente del mismo alcance',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCommissionRuleDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CommissionRuleResponseDto> {
    return CommissionMapper.regla(
      await this.reglas.update(id, dto, distributorId),
    );
  }
}
