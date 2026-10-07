import type { Response } from 'express';
import { ApiTotal, informarTotal } from '../common/http/total';
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CylinderService } from './cylinder.service';
import { CylinderMapper } from './cylinder.mapper';
import {
  CylinderMovementResponseDto,
  CylinderResponseDto,
} from './dto/cylinder-response.dto';
import { CreateCylinderDto } from './dto/create-cylinder.dto';
import { TransitionCylinderDto } from './dto/transition-cylinder.dto';
import { UpdateCylinderDto } from './dto/update-cylinder.dto';
import { RetireCylinderDto } from './dto/retire-cylinder.dto';
import { AssignCylindersDto } from './dto/assign-cylinders.dto';
import { QueryCylindersDto } from './dto/query-cylinders.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';

@ApiTags('Cylinders')
@ApiBearerAuth()
@Controller('cylinders')
export class CylinderController {
  constructor(private readonly cylinderService: CylinderService) {}

  @Post()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Dar de alta un envase físico (IN_DEPOT)' })
  @ApiCreatedResponse({ type: CylinderResponseDto })
  @ApiConflictResponse({
    description: 'El serial ya existe en tu distribuidora',
  })
  @ApiBadRequestResponse({
    description: 'Datos inválidos (p. ej.: gasCylinderId must be a UUID)',
  })
  async create(
    @Body() dto: CreateCylinderDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CylinderResponseDto> {
    return CylinderMapper.toDto(
      await this.cylinderService.create(dto, distributorId),
    );
  }

  @Post('assign')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY)
  @ApiOperation({
    summary:
      'Asignar envases (por serial) a un pedido y despacharlos (FILLED→DISPATCHED)',
  })
  @ApiCreatedResponse({ type: CylinderResponseDto, isArray: true })
  @ApiBadRequestResponse({
    description: 'Algún envase no está FILLED (no se puede despachar)',
  })
  @ApiNotFoundResponse({ description: 'Pedido o envase no encontrado' })
  async assign(
    @Body() dto: AssignCylindersDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CylinderResponseDto[]> {
    const cylinders = await this.cylinderService.assignToOrder(
      dto.orderId,
      dto.serials,
      distributorId,
      user.user_id,
    );
    return cylinders.map((c) => CylinderMapper.toDto(c));
  }

  @Get()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Listar envases (scopeado por distribuidora)',
    description:
      'Filtros combinables: `state`, `orderId` (envases que salieron en ese ' +
      'pedido, también los de un pedido ya entregado) y `customerUserId` ' +
      '(user_id del cliente, no el customer_id del perfil: los envases que ' +
      'tiene hoy). Paginación opcional con `limit`/`offset`; sin ellos ' +
      'devuelve todos. `X-Total-Count` trae el total sin paginar. Cada ítem ' +
      'trae `lastMovementAt`.',
  })
  @ApiOkResponse({ type: CylinderResponseDto, isArray: true })
  @ApiTotal()
  @ApiBadRequestResponse({
    description: 'Estado inválido, UUID inválido o paginación fuera de rango',
  })
  async findAll(
    @Query() query: QueryCylindersDto,
    @Res({ passthrough: true }) res: Response,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<CylinderResponseDto[]> {
    const [cylinders, total] = await this.cylinderService.findAll(
      distributorId,
      query,
    );
    informarTotal(res, total);
    return cylinders.map((c) => CylinderMapper.toDto(c));
  }

  @Get(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY)
  @ApiOperation({ summary: 'Ver un envase' })
  @ApiParam({ name: 'id', description: 'Cylinder UUID' })
  @ApiOkResponse({ type: CylinderResponseDto })
  @ApiNotFoundResponse({ description: 'Envase no encontrado' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<CylinderResponseDto> {
    return CylinderMapper.toDto(
      await this.cylinderService.findOne(id, distributorId),
    );
  }

  @Get(':id/history')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Historial de movimientos/transiciones del envase' })
  @ApiParam({ name: 'id', description: 'Cylinder UUID' })
  @ApiOkResponse({ type: CylinderMovementResponseDto, isArray: true })
  @ApiNotFoundResponse({ description: 'Envase no encontrado' })
  async getHistory(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<CylinderMovementResponseDto[]> {
    const movimientos = await this.cylinderService.getHistory(
      id,
      distributorId,
    );
    return movimientos.map((m) => CylinderMapper.movimientoToDto(m));
  }

  @Patch(':id')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Editar datos maestros del envase (no el estado)',
    description:
      'Serial, producto, depósito y fechas de fabricación, inspección y ' +
      'vencimiento. El estado cambia sólo por `/transition` y `/retire`.',
  })
  @ApiParam({ name: 'id', description: 'Cylinder UUID' })
  @ApiOkResponse({ type: CylinderResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiNotFoundResponse({ description: 'Envase no encontrado' })
  @ApiConflictResponse({
    description: 'Serial repetido en la distribuidora, o envase dado de baja',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCylinderDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CylinderResponseDto> {
    return CylinderMapper.toDto(
      await this.cylinderService.update(id, dto, distributorId),
    );
  }

  @Patch(':id/retire')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Dar de baja el envase (estado terminal RETIRED), con motivo',
    description:
      'Sólo desde `in_depot` o `empty_returned`. El registro no se borra: ' +
      'queda para histórico y el motivo en el historial.',
  })
  @ApiParam({ name: 'id', description: 'Cylinder UUID' })
  @ApiOkResponse({ type: CylinderResponseDto })
  @ApiBadRequestResponse({
    description:
      'Motivo faltante o el envase no está en un estado dable de baja',
  })
  @ApiNotFoundResponse({ description: 'Envase no encontrado' })
  async retire(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RetireCylinderDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CylinderResponseDto> {
    return CylinderMapper.toDto(
      await this.cylinderService.retire(
        id,
        dto.reason,
        distributorId,
        user.user_id,
      ),
    );
  }

  @Patch(':id/transition')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY)
  @ApiOperation({
    summary:
      'Transicionar el estado del envase (admin llena/deposita, chofer despacha/entrega/recibe vacío)',
  })
  @ApiParam({ name: 'id', description: 'Cylinder UUID' })
  @ApiOkResponse({ type: CylinderResponseDto })
  @ApiBadRequestResponse({ description: 'Transición inválida' })
  @ApiNotFoundResponse({ description: 'Envase no encontrado' })
  async transition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionCylinderDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CylinderResponseDto> {
    return CylinderMapper.toDto(
      await this.cylinderService.transition(
        id,
        dto,
        distributorId,
        user.user_id,
      ),
    );
  }
}
