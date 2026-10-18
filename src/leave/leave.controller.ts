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
import { LeaveService } from './leave.service';
import { LeaveMapper } from './leave.mapper';
import { CreateLeaveDto, UpdateLeaveDto } from './dto/create-leave.dto';
import { RejectLeaveDto } from './dto/reject-leave.dto';
import { QueryLeaveDto, QueryVacationBalanceDto } from './dto/query-leave.dto';
import {
  LeavePageDto,
  LeaveResponseDto,
  VacationBalanceDto,
} from './dto/leave-response.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';

/**
 * Licencias y ausencias del personal. Las que se cargan sobre un empleado
 * viven bajo `/employees/:id/...`; la bandeja y las decisiones, bajo `/leaves`.
 */
@ApiTags('Personal · Licencias')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller()
export class LeaveController {
  constructor(private readonly leaves: LeaveService) {}

  @Post('employees/:id/leaves')
  @Idempotent()
  @ApiOperation({
    summary: 'Registrar una licencia o ausencia: nace solicitada (CU-191)',
  })
  @ApiParam({ name: 'id', description: 'Empleado UUID' })
  @ApiCreatedResponse({ type: LeaveResponseDto })
  @ApiBadRequestResponse({
    description: 'Datos inválidos o fin anterior al inicio',
  })
  @ApiNotFoundResponse({ description: 'Empleado no encontrado' })
  @ApiConflictResponse({
    description:
      'El empleado está egresado, o el período se superpone con otra licencia solicitada o aprobada',
  })
  async create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateLeaveDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<LeaveResponseDto> {
    return LeaveMapper.toDto(
      await this.leaves.create(id, dto, distributorId, actorUserId),
    );
  }

  @Get('employees/:id/vacation-balance')
  @ApiOperation({
    summary: 'Consultar el saldo de vacaciones de un empleado (CU-193)',
    description:
      'Días que corresponden por antigüedad al 31/12 (LCT art. 150), días tomados (vacaciones aprobadas del año) y saldo. Se calcula en cada consulta.',
  })
  @ApiParam({ name: 'id', description: 'Empleado UUID' })
  @ApiOkResponse({ type: VacationBalanceDto })
  @ApiBadRequestResponse({ description: 'Año inválido' })
  @ApiNotFoundResponse({ description: 'Empleado no encontrado' })
  vacationBalance(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: QueryVacationBalanceDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<VacationBalanceDto> {
    return this.leaves.vacationBalance(id, distributorId, query.year);
  }

  @Get('leaves')
  @ApiOperation({
    summary: 'Consultar las licencias y la bandeja de pendientes (CU-319)',
  })
  @ApiOkResponse({ type: LeavePageDto })
  @ApiBadRequestResponse({ description: 'Un filtro tiene un valor inválido' })
  async findAll(
    @Query() query: QueryLeaveDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<LeavePageDto> {
    const { data, total } = await this.leaves.findAll(query, distributorId);
    return { data: data.map((l) => LeaveMapper.toDto(l)), total };
  }

  @Patch('leaves/:id')
  @ApiOperation({
    summary: 'Modificar una licencia solicitada (CU-316)',
  })
  @ApiParam({ name: 'id', description: 'Licencia UUID' })
  @ApiOkResponse({ type: LeaveResponseDto })
  @ApiBadRequestResponse({ description: 'Fin anterior al inicio' })
  @ApiNotFoundResponse({ description: 'Licencia no encontrada' })
  @ApiConflictResponse({
    description: 'No está solicitada, o el período se superpone con otra',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLeaveDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<LeaveResponseDto> {
    return LeaveMapper.toDto(await this.leaves.update(id, dto, distributorId));
  }

  @Patch('leaves/:id/approve')
  @ApiOperation({ summary: 'Aprobar una solicitud de licencia (CU-192)' })
  @ApiParam({ name: 'id', description: 'Licencia UUID' })
  @ApiOkResponse({ type: LeaveResponseDto })
  @ApiNotFoundResponse({ description: 'Licencia no encontrada' })
  @ApiConflictResponse({ description: 'No está solicitada' })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<LeaveResponseDto> {
    return LeaveMapper.toDto(
      await this.leaves.approve(id, distributorId, actorUserId),
    );
  }

  @Patch('leaves/:id/reject')
  @ApiOperation({
    summary: 'Rechazar una solicitud de licencia, con motivo (CU-318)',
  })
  @ApiParam({ name: 'id', description: 'Licencia UUID' })
  @ApiOkResponse({ type: LeaveResponseDto })
  @ApiBadRequestResponse({ description: 'Falta el motivo' })
  @ApiNotFoundResponse({ description: 'Licencia no encontrada' })
  @ApiConflictResponse({ description: 'No está solicitada' })
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectLeaveDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<LeaveResponseDto> {
    return LeaveMapper.toDto(
      await this.leaves.reject(id, dto.reason, distributorId, actorUserId),
    );
  }

  @Patch('leaves/:id/cancel')
  @ApiOperation({
    summary: 'Cancelar una licencia que todavía no terminó (CU-317)',
  })
  @ApiParam({ name: 'id', description: 'Licencia UUID' })
  @ApiOkResponse({ type: LeaveResponseDto })
  @ApiNotFoundResponse({ description: 'Licencia no encontrada' })
  @ApiConflictResponse({
    description: 'Ya estaba rechazada o cancelada, o ya terminó',
  })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') actorUserId: string,
  ): Promise<LeaveResponseDto> {
    return LeaveMapper.toDto(
      await this.leaves.cancel(id, distributorId, actorUserId),
    );
  }
}
