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

/**
 * Tareas de flota con su estado de pago (API v2): el costo de un servicio
 * hecho (VTV, service, frenos…) sale de una caja de efectivo, banco o
 * billetera. El resto de las operaciones sigue en `/fleet/tasks` (v1).
 */
@ApiTags('Fleet · Tasks (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'fleet/tasks', version: '2' })
export class FleetTaskV2Controller {
  constructor(private readonly tasks: FleetTaskService) {}

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

  @Get(':id')
  @ApiOperation({ summary: 'Ver una tarea, con su estado de pago' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiOkResponse({ type: FleetTaskV2ResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otra distribuidora' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<FleetTaskV2ResponseDto> {
    return FleetTaskMapper.toV2Dto(await this.tasks.findOne(id, distributorId));
  }

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
      ),
    );
  }

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
