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
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { RejectProposalDto } from './dto/planner-request.dto';
import {
  DriverMaintenanceSettingsResponseDto,
  DriverProposalPageDto,
  DriverProposalResponseDto,
} from './dto/planner-response.dto';
import { MaintenancePlannerMapper } from './maintenance-planner.mapper';
import { MaintenancePlannerService } from './maintenance-planner.service';

/**
 * Ventanas de taller que el planificador le propone al chofer (CU-105). La
 * propuesta nueva le llega por el socket `maintenance:proposal`, por push y por
 * correo; la respuesta es aceptar o rechazar con motivo (pudiendo proponer otra
 * ventana). Todo es del chofer autenticado: la propuesta de otro es un 404.
 */
@ApiTags('Driver · Maintenance proposals (v2)')
@Auth(RoleType.DELIVERY)
@Controller({ path: 'driver/maintenance-proposals', version: '2' })
export class DriverMaintenanceProposalsController {
  constructor(private readonly planner: MaintenancePlannerService) {}

  @Get('settings')
  @ApiOperation({
    summary: 'Horario y días de taller de mi distribuidora',
    description:
      'Lo que la app necesita para validar la ventana alternativa antes de mandarla: horario de taller, días hábiles, feriados, aviso mínimo y horizonte.',
  })
  @ApiOkResponse({ type: DriverMaintenanceSettingsResponseDto })
  settings(
    @CurrentUser('user_id') userId: string,
  ): Promise<DriverMaintenanceSettingsResponseDto> {
    return this.planner.ajustesParaElChofer(userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Una de mis propuestas de ventana de taller' })
  @ApiParam({ name: 'id', description: 'Proposal UUID' })
  @ApiOkResponse({ type: DriverProposalResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otro chofer' })
  one(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<DriverProposalResponseDto> {
    return this.uno(userId, id);
  }

  @Get()
  @ApiOperation({
    summary: 'Mis propuestas de ventana de taller',
    description:
      'Las del chofer: primero la que espera respuesta (`status: pending`, con su `expiresAt`) y después, de la más próxima a la más lejana.',
  })
  @ApiOkResponse({ type: DriverProposalPageDto })
  async list(
    @Query() query: PaginationDto,
    @CurrentUser('user_id') userId: string,
  ): Promise<DriverProposalPageDto> {
    const [data, total] = await this.planner.propuestasDelChofer(
      userId,
      query.limit ?? 10,
      query.offset ?? 0,
    );
    return {
      data: data.map((p) => MaintenancePlannerMapper.driverProposal(p)),
      total,
    };
  }

  @Post(':id/accept')
  @Idempotent()
  @ApiOperation({
    summary: 'Aceptar la ventana de taller',
    description:
      'El caso queda a la espera de que el administrador confirme el taller y el gasto; recién entonces la tarea se programa.',
  })
  @ApiParam({ name: 'id', description: 'Proposal UUID' })
  @ApiCreatedResponse({ type: DriverProposalResponseDto })
  @ApiNotFoundResponse({ description: 'No existe o es de otro chofer' })
  @ApiConflictResponse({ description: 'Ya respondida, vencida o cancelada' })
  async accept(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<DriverProposalResponseDto> {
    await this.planner.aceptar(userId, id);
    return this.uno(userId, id);
  }

  @Post(':id/reject')
  @Idempotent()
  @ApiOperation({
    summary: 'Rechazar la ventana de taller, con motivo',
    description:
      'Se le ofrece la ventana siguiente; si se agotan las alternativas, el caso se escala al administrador. Con `alternative` propone otra ventana: si es viable queda acordada a la espera del administrador.',
  })
  @ApiParam({ name: 'id', description: 'Proposal UUID' })
  @ApiCreatedResponse({ type: DriverProposalResponseDto })
  @ApiBadRequestResponse({
    description: 'Sin motivo, o la ventana alternativa no es viable',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otro chofer' })
  @ApiConflictResponse({ description: 'Ya respondida, vencida o cancelada' })
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectProposalDto,
    @CurrentUser('user_id') userId: string,
  ): Promise<DriverProposalResponseDto> {
    await this.planner.rechazar(userId, id, {
      reason: dto.reason,
      alternative: dto.alternative
        ? {
            start: new Date(dto.alternative.start),
            end: new Date(dto.alternative.end),
          }
        : undefined,
    });
    return this.uno(userId, id);
  }

  private async uno(
    userId: string,
    id: string,
  ): Promise<DriverProposalResponseDto> {
    return MaintenancePlannerMapper.driverProposal(
      await this.planner.propuestaDelChofer(userId, id),
    );
  }
}
