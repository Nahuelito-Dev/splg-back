import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
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
  ApiExtraModels,
  ApiHeader,
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
import { CloseFleetTaskV2Dto } from './dto/close-task.dto';
import { PayFleetTaskDto } from './dto/pay-task.dto';
import { QueryFleetTaskDto } from './dto/query-task.dto';
import {
  FleetTaskV2PageDto,
  FleetTaskV2ResponseDto,
} from './dto/task-response.dto';
import { FleetTaskMapper } from './fleet-task.mapper';
import { FleetTaskService } from './fleet-task.service';
import { FleetTaskBoardService } from './fleet-task-board.service';
import { CreateFleetTaskV2Dto } from './dto/create-task.dto';
import { UpdateFleetTaskV2Dto } from './dto/update-task.dto';
import {
  FleetTaskBoardCardDto,
  FleetTaskBoardDto,
  FleetTaskBoardEventDto,
  FleetTaskBoardQueryDto,
  MoveFleetTaskDto,
} from './dto/task-board.dto';

const CABECERA_IF_MATCH = {
  name: 'If-Match',
  required: false,
  description:
    'Precondición: el `updatedAt` de la tarea (ISO 8601) que tiene el panel. Si cambió, 409 `FLEET_TASK_STALE`. El campo `expectedUpdatedAt` del cuerpo tiene prioridad',
};

/**
 * La precondición del tablero: el campo del cuerpo o, si no vino, la cabecera
 * `If-Match` (con o sin comillas). Una cabecera que no es una fecha, 400.
 */
function precondicion(
  delCuerpo: string | undefined,
  cabecera: string | undefined,
): Date | undefined {
  if (delCuerpo) return new Date(delCuerpo);
  const valor = cabecera?.replace(/^W\//, '').replace(/"/g, '').trim();
  if (!valor) return undefined;
  const fecha = new Date(valor);
  if (Number.isNaN(fecha.getTime())) {
    throw new BadRequestException(
      'If-Match: tiene que ser la fecha de la última modificación de la tarea',
    );
  }
  return fecha;
}
import { Permiso } from '../common/decorators/permiso.decorator';

/**
 * Tareas de flota con su estado de pago (API v2): el costo de un servicio
 * hecho (VTV, service, frenos…) sale de una caja de efectivo, banco o
 * billetera. El resto de las operaciones sigue en `/fleet/tasks` (v1).
 */
@ApiTags('Fleet · Tasks (v2)')
// El aviso del tablero viaja por socket (`fleet:task`): se publica para que el panel tenga su tipo.
@ApiExtraModels(FleetTaskBoardEventDto)
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'fleet/tasks', version: '2' })
export class FleetTaskV2Controller {
  constructor(
    private readonly tasks: FleetTaskService,
    private readonly board: FleetTaskBoardService,
  ) {}

  // Antes de `GET :id`: si no, `board` se leería como un id.
  @Permiso('flota.ver')
  @Get('board')
  @ApiOperation({
    summary: 'Tablero de tareas: columnas por estado',
    description:
      'Columnas `forecast`, `scheduled`, `in_progress` y `done` (las hechas desde `doneSince`, 30 días por omisión, la más reciente primero); las demás ordenadas por `position`. Las vencidas quedan en su columna con `isOverdue: true`. Las canceladas sólo se cuentan. Los cambios llegan por el socket del panel en el evento `fleet:task` (`{ id, change, card }`)',
  })
  @ApiOkResponse({ type: FleetTaskBoardDto })
  @ApiBadRequestResponse({
    description:
      'Un filtro con formato inválido (id que no es UUID, fecha irreal, tipo desconocido, texto de más de 100 caracteres)',
  })
  async boardView(
    @Query() query: FleetTaskBoardQueryDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FleetTaskBoardDto> {
    return this.board.tablero(distributorId, query);
  }

  @Permiso('flota.gestionar')
  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Crear una tarea, con su responsable',
    description:
      'Igual que `POST /fleet/tasks` (v1) más `assigneeEmployeeId`. La tarea entra al final de su columna del tablero',
  })
  @ApiCreatedResponse({ type: FleetTaskV2ResponseDto })
  @ApiBadRequestResponse({
    description:
      'Cuerpo inválido, o el vehículo/chofer/empleado no coincide con el sujeto del plan',
  })
  @ApiNotFoundResponse({
    description:
      'Plan, vehículo, chofer, empleado o responsable no encontrado (o de otra distribuidora)',
  })
  @ApiConflictResponse({
    description: 'El empleado del plan o el responsable está egresado',
  })
  async create(
    @Body() dto: CreateFleetTaskV2Dto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FleetTaskV2ResponseDto> {
    return FleetTaskMapper.toV2Dto(await this.tasks.create(dto, distributorId));
  }

  @Permiso('flota.gestionar')
  @Patch(':id')
  @ApiOperation({
    summary: 'Editar una tarea abierta, con su responsable',
    description:
      'Igual que `PATCH /fleet/tasks/:id` (v1) más el responsable (`assigneeEmployeeId`, `null` lo quita) y la precondición (`expectedUpdatedAt` o `If-Match`)',
  })
  @ApiHeader(CABECERA_IF_MATCH)
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiOkResponse({ type: FleetTaskV2ResponseDto })
  @ApiBadRequestResponse({
    description:
      'El id no es un UUID, el cuerpo trae un campo que no se puede editar o con formato inválido, `If-Match` no es una fecha, el inicio de la vigencia es posterior al vencimiento o el detalle no es válido para el plan',
  })
  @ApiNotFoundResponse({
    description: 'Tarea o responsable no encontrado (o de otra distribuidora)',
  })
  @ApiConflictResponse({
    description:
      'La tarea ya está hecha o cancelada, el responsable está egresado, o la tarea cambió desde que se leyó (`FLEET_TASK_STALE`)',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFleetTaskV2Dto,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<FleetTaskV2ResponseDto> {
    const { assigneeEmployeeId, expectedUpdatedAt, ...cambios } = dto;
    return FleetTaskMapper.toV2Dto(
      await this.tasks.update(id, cambios, distributorId, userId, {
        assigneeEmployeeId,
        expectedUpdatedAt: precondicion(expectedUpdatedAt, ifMatch),
      }),
    );
  }

  @Permiso('flota.gestionar')
  @Post(':id/move')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mover una tarjeta del tablero',
    description:
      'Transiciones: `forecast → scheduled` (con `scheduledAt`), `scheduled → forecast` (borra el turno y cancela la ventana confirmada del planificador), `scheduled ↔ in_progress`. A la misma columna sólo reordena. A «hecha» se llega con `POST /v2/fleet/tasks/:id/close`; cancelar, con `PATCH /fleet/tasks/:id/cancel`. Responde la tarjeta como quedó',
  })
  @ApiHeader(CABECERA_IF_MATCH)
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiOkResponse({ type: FleetTaskBoardCardDto })
  @ApiBadRequestResponse({
    description:
      'Cuerpo inválido (destino desconocido o `done`, fecha irreal, id que no es UUID), `If-Match` no es una fecha, falta el turno al programar (`FLEET_TASK_SCHEDULED_AT_REQUIRED`), turno en otro destino (`FLEET_TASK_SCHEDULED_AT_NOT_ALLOWED`), día inválido (`SCHEDULED_DAY_INVALID`), ventana del planificador en el pasado (`SCHEDULED_WINDOW_IN_PAST`), o la tarjeta de referencia no está en la columna de destino de la empresa, es la misma o están al revés (`FLEET_TASK_NEIGHBOR_INVALID`)',
  })
  @ApiNotFoundResponse({
    description: 'La tarea no existe o es de otra distribuidora',
  })
  @ApiConflictResponse({
    description:
      'La tarea está hecha o cancelada (`FLEET_TASK_CLOSED`), la transición no está permitida (`FLEET_TASK_TRANSITION_NOT_ALLOWED`), o la tarea cambió desde que se leyó (`FLEET_TASK_STALE`)',
  })
  async move(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MoveFleetTaskDto,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<FleetTaskBoardCardDto> {
    return this.board.mover(
      id,
      dto,
      distributorId,
      userId,
      precondicion(dto.expectedUpdatedAt, ifMatch),
    );
  }

  @Permiso('flota.ver')
  @Get()
  @ApiOperation({ summary: 'Listar tareas, con su estado de pago' })
  @ApiOkResponse({ type: FleetTaskV2PageDto })
  async findAll(
    @Query() query: QueryFleetTaskDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FleetTaskV2PageDto> {
    const [data, total] = await this.tasks.findAll(distributorId, query);
    return { data: data.map((t) => FleetTaskMapper.toV2Dto(t)), total };
  }

  @Permiso('flota.ver')
  @Get(':id')
  @ApiOperation({ summary: 'Ver una tarea, con su estado de pago' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiOkResponse({ type: FleetTaskV2ResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FleetTaskV2ResponseDto> {
    return FleetTaskMapper.toV2Dto(await this.tasks.findOne(id, distributorId));
  }

  @Permiso('flota.gestionar')
  @Post(':id/close')
  @Idempotent()
  @ApiOperation({
    summary: 'Registrar que el mantenimiento se hizo, y pagarlo en el acto',
    description:
      'Igual que el cierre v1 (`PATCH /fleet/tasks/:id/close`) y, con `payment`, el costo sale de la caja elegida en la misma transacción.',
  })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiCreatedResponse({ type: FleetTaskV2ResponseDto })
  @ApiBadRequestResponse({
    description:
      'Fecha futura, `payment` sin costo, caja que no admite el pago o `paidAt` futuro',
  })
  @ApiNotFoundResponse({ description: 'Tarea o caja no encontrada' })
  @ApiConflictResponse({
    description:
      'La tarea ya está hecha o cancelada, o la caja no tiene sesión abierta o saldo',
  })
  async close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseFleetTaskV2Dto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<FleetTaskV2ResponseDto> {
    const { payment, ...cierre } = dto;
    return FleetTaskMapper.toV2Dto(
      await this.tasks.close(
        id,
        cierre,
        distributorId,
        payment ? { ...payment, userId } : undefined,
        { cerradaComoConflicto: true },
      ),
    );
  }

  @Permiso('flota.gestionar')
  @Post(':id/pay')
  @Idempotent()
  @ApiOperation({
    summary: 'Registrar el pago de una tarea hecha',
    description:
      'Egreso de la caja elegida (efectivo, banco o billetera), categoría «Mantenimiento de flota». Una sola vez por tarea; `amount` por omisión es el costo.',
  })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiCreatedResponse({ type: FleetTaskV2ResponseDto })
  @ApiBadRequestResponse({
    description:
      'Importe mayor que el costo, `paidAt` futuro o caja que no admite el pago',
  })
  @ApiNotFoundResponse({ description: 'Tarea o caja no encontrada' })
  @ApiConflictResponse({
    description:
      'La tarea no está hecha, no tiene costo, ya está paga, o la caja no tiene sesión abierta o saldo',
  })
  async pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayFleetTaskDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<FleetTaskV2ResponseDto> {
    return FleetTaskMapper.toV2Dto(
      await this.tasks.pagar(id, dto, distributorId, userId),
    );
  }
}
