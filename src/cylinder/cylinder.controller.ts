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
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { CylinderService } from './cylinder.service';
import { CylinderVigenciaService } from './cylinder-vigencia.service';
import { CylinderMapper } from './cylinder.mapper';
import {
  CylinderVigenciaResponseDto,
  ExpiringCylindersResponseDto,
} from './dto/cylinder-vigencia-response.dto';
import {
  CylinderExpiredResponseDto,
  PedidoNoDespachableResponseDto,
} from './cylinder-vencido.exception';
import { RegisterInspectionDto } from './dto/register-inspection.dto';
import { QueryExpiringCylindersDto } from './dto/query-expiring-cylinders.dto';
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
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';

@ApiTags('Cylinders')
@ApiBearerAuth()
@ApiExtraModels(CylinderExpiredResponseDto, PedidoNoDespachableResponseDto)
@Controller('cylinders')
export class CylinderController {
  constructor(
    private readonly cylinderService: CylinderService,
    private readonly vigencia: CylinderVigenciaService,
  ) {}

  @Post()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Dar de alta un envase físico (IN_DEPOT)' })
  @ApiCreatedResponse({ type: CylinderResponseDto })
  @ApiConflictResponse({
    description: 'El serial ya existe en tu distribuidora',
  })
  @ApiBadRequestResponse({
    description: 'Datos inválidos (p. ej.: Producto: no es válido)',
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
  @Idempotent()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY)
  @ApiOperation({
    summary:
      'Asignar envases (por serial) a un pedido y despacharlos (FILLED→DISPATCHED)',
  })
  @ApiCreatedResponse({ type: CylinderResponseDto, isArray: true })
  @ApiBadRequestResponse({
    description:
      'Algún envase no está FILLED (no se puede despachar) o hay seriales repetidos',
  })
  @ApiConflictResponse({
    schema: {
      anyOf: [
        { $ref: getSchemaPath(CylinderExpiredResponseDto) },
        { $ref: getSchemaPath(PedidoNoDespachableResponseDto) },
      ],
    },
    description:
      'Algún envase tiene la revisión vencida: se rechaza la asignación ' +
      'completa y no se asigna ninguno. El cuerpo trae `code: ' +
      'CYLINDER_EXPIRED` y `serials` con los vencidos. Los envases sin ' +
      'vencimiento cargado pasan. También 409 si el pedido no admite la ' +
      'carga: sólo se asigna a pedidos pendientes, aceptados o en camino ' +
      '(no entregados, cancelados ni reservados a futuro).',
  })
  @ApiNotFoundResponse({
    description:
      'Pedido o envase no encontrado. Un chofer que no es el asignado al pedido ' +
      'recibe el mismo 404: el pedido ajeno no existe para él',
  })
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
      user.role,
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

  @Get('vigencia/proximos-a-vencer')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Envases próximos a vencer (CU-134)',
    description:
      'Separa los ya vencidos, los que vencen dentro de la ventana de `days` ' +
      'días (default 30) y los sin revisión registrada, que no tienen fecha ' +
      'con la cual comparar. Cada grupo va ordenado por vencimiento, del más ' +
      'urgente al menos, y se pagina por separado con `limit` (default 100, ' +
      'máx. 500) y `offset`; `totals` trae el total de cada grupo. No incluye ' +
      'envases dados de baja.',
  })
  @ApiOkResponse({ type: ExpiringCylindersResponseDto })
  @ApiBadRequestResponse({
    description: '`days` o la paginación fuera de rango',
  })
  async expiring(
    @Query() query: QueryExpiringCylindersDto,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<ExpiringCylindersResponseDto> {
    return CylinderMapper.vencimientosToDto(
      await this.vigencia.findExpiring(
        query.days ?? 30,
        distributorId,
        query.limit ?? 100,
        query.offset ?? 0,
      ),
    );
  }

  @Get('vigencia/serial/:serial')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Vigencia de un envase por número de serie (CU-133)',
    description:
      'Lo que se escanea: el serial grabado en el envase. El serial es único ' +
      'por distribuidora, así que el super admin tiene que elegir una con ' +
      '`X-Distributor` (400 si no).',
  })
  @ApiParam({ name: 'serial', example: 'SN-000123' })
  @ApiOkResponse({ type: CylinderVigenciaResponseDto })
  @ApiNotFoundResponse({ description: 'Envase no encontrado' })
  async vigenciaBySerial(
    @Param('serial') serial: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CylinderVigenciaResponseDto> {
    return CylinderMapper.vigenciaToDto(
      await this.vigencia.getVigenciaBySerial(serial, distributorId),
    );
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

  @Get(':id/vigencia')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Vigencia de un envase (CU-133)',
    description:
      'Fabricación, última revisión, vencimiento, días que faltan e historial ' +
      'de revisiones. `status`: `valid`, `expired` o `unverified` (sin revisión ' +
      'registrada: no es lo mismo que vencido y no bloquea el despacho).',
  })
  @ApiParam({ name: 'id', description: 'Cylinder UUID' })
  @ApiOkResponse({ type: CylinderVigenciaResponseDto })
  @ApiNotFoundResponse({ description: 'Envase no encontrado' })
  async getVigencia(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<CylinderVigenciaResponseDto> {
    return CylinderMapper.vigenciaToDto(
      await this.vigencia.getVigencia(id, distributorId),
    );
  }

  @Post(':id/inspections')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Registrar la revisión periódica de un envase (CU-132)',
    description:
      'Guarda la revisión en el historial y copia la última fecha y el ' +
      'vencimiento en la ficha. Un resultado `rejected` deja el vencimiento ' +
      'en la fecha de la revisión: el envase queda alcanzado por el bloqueo ' +
      'del despacho. Si está en poder de un cliente o en reparto no se lo ' +
      'saca de circulación: `withdrawalPending` lo marca para retirar.',
  })
  @ApiParam({ name: 'id', description: 'Cylinder UUID' })
  @ApiCreatedResponse({ type: CylinderVigenciaResponseDto })
  @ApiBadRequestResponse({
    description:
      'Fecha de revisión futura, vencimiento faltante o no posterior a la revisión',
  })
  @ApiNotFoundResponse({ description: 'Envase no encontrado' })
  @ApiConflictResponse({ description: 'El envase está dado de baja' })
  async registerInspection(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegisterInspectionDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CylinderVigenciaResponseDto> {
    return CylinderMapper.vigenciaToDto(
      await this.vigencia.registerInspection(
        id,
        dto,
        distributorId,
        user.user_id,
      ),
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
  @ApiBadRequestResponse({
    description:
      'Transición inválida, o `with_customer` sin `orderId` (el pedido da el titular), o texto con caracteres no válidos en `note`',
  })
  @ApiConflictResponse({
    schema: {
      anyOf: [
        { $ref: getSchemaPath(CylinderExpiredResponseDto) },
        { $ref: getSchemaPath(PedidoNoDespachableResponseDto) },
      ],
    },
    description:
      'Despachar (`dispatched`) un envase con la revisión vencida: el mismo ' +
      '409 `CYLINDER_EXPIRED` que la asignación a un pedido. También 409 si ' +
      'se despacha con un `orderId` de un pedido que no admite la carga ' +
      '(entregado, cancelado o reservado a futuro). Un chofer que indica un ' +
      '`orderId` distinto del pedido al que ya está atado el envase también ' +
      'recibe 409.',
  })
  @ApiForbiddenResponse({
    description:
      'Un chofer sin `orderId` sobre un envase que no está atado a ningún ' +
      'pedido: las tareas de depósito son del administrador',
  })
  @ApiNotFoundResponse({
    description:
      'Envase o pedido no encontrado. Un chofer que indica el `orderId` de un ' +
      'pedido que no tiene asignado, o mueve un envase atado a un pedido de ' +
      'otro chofer, recibe el mismo 404',
  })
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
        user.role,
      ),
    );
  }
}
