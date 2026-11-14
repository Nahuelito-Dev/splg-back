import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  Patch,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
  ApiConflictResponse,
} from '@nestjs/swagger';
import { TimeSlotMapper } from './time-slot.mapper';
import {
  SlotAvailabilityDto,
  TimeSlotResponseDto,
} from './dto/time-slot-response.dto';
import { ListarFranjasQueryDto } from './dto/listar-franjas-query.dto';
import { TimeSlotService } from './time-slot.service';
import { AvailabilityQueryDto } from './dto/availability-query.dto';
import { CreateTimeSlotDto } from './dto/create-time-slot.dto';
import { UpdateTimeSlotDto } from './dto/update-time-slot.dto';
import { Public } from '../common/decorators/isPublic.decorator';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { esSuperAdminDePlataforma } from '../common/utils/alcance.util';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { Permiso } from '../common/decorators/permiso.decorator';

@ApiTags('Time Slots')
@ApiBearerAuth()
@Controller('time-slot')
export class TimeSlotController {
  constructor(private readonly timeSlotService: TimeSlotService) {}

  @Post()
  @Permiso('catalogo.gestionar')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create a new time slot' })
  @ApiCreatedResponse({ type: TimeSlotResponseDto })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: Nombre: no puede estar vacío; Hora de inicio: tiene que ser una hora con formato HH:MM), inicio >= fin o capacidad fuera de 1-10000',
  })
  @ApiConflictResponse({
    description:
      'La franja se solapa con otra franja activa de la distribuidora, o ya hay una activa con ese nombre',
  })
  async create(
    @Body() createTimeSlotDto: CreateTimeSlotDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TimeSlotResponseDto> {
    return TimeSlotMapper.toDto(
      await this.timeSlotService.create(createTimeSlotDto, distributorId),
    );
  }

  @Get()
  @Permiso('catalogo.ver')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'List active time slots (scopeado por la distribuidora del admin; ' +
      '?distributor lo overridea sólo para super_admin; un admin queda en su ' +
      'distribuidora)',
    description:
      'Con `?includeInactive=true` incluye también las franjas dadas de baja ' +
      '(cada una trae `isActive`); se reactivan con `PATCH /time-slot/:id {isActive:true}`.',
  })
  @ApiOkResponse({ type: TimeSlotResponseDto, isArray: true })
  @ApiBadRequestResponse({ description: 'Query inválida' })
  async findAll(
    @CurrentDistributor() distributorId: string | null,
    @CurrentUser() user: AuthenticatedUser,
    @Query() { distributor, includeInactive }: ListarFranjasQueryDto,
  ): Promise<TimeSlotResponseDto[]> {
    // `?distributor=` es sólo del super admin fuera de soporte: un admin (y el
    // super admin en una sesión de soporte) queda en su tenant.
    const slots = await this.timeSlotService.findAll(
      esSuperAdminDePlataforma(user) ? distributor : undefined,
      distributorId,
      includeInactive,
    );
    return slots.map((s) => TimeSlotMapper.toDto(s));
  }

  @Get('availability')
  @Public()
  @ApiOperation({
    summary: 'Disponibilidad de franjas para una fecha (agendamiento)',
    description:
      'Devuelve cada franja activa de la distribuidora con capacidad, ' +
      'reservados y cupos libres para la fecha dada (YYYY-MM-DD). Soporta ' +
      'same-day. La distribuidora se pasa por ?distributor=slug|uuid.',
  })
  @ApiOkResponse({ type: SlotAvailabilityDto, isArray: true })
  @ApiBadRequestResponse({ description: 'Fecha o distribuidora inválida' })
  getAvailability(
    @Query() query: AvailabilityQueryDto,
  ): Promise<SlotAvailabilityDto[]> {
    return this.timeSlotService.getAvailability(query.date, query.distributor);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get time slot by ID' })
  @ApiOkResponse({ type: TimeSlotResponseDto })
  @ApiNotFoundResponse({
    description: 'La franja no existe o es de otra distribuidora',
  })
  @ApiUnauthorizedResponse({ description: 'Sin token o token inválido' })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<TimeSlotResponseDto> {
    return TimeSlotMapper.toDto(
      await this.timeSlotService.findOne(id, distributorId),
    );
  }

  @Patch(':id')
  @Permiso('catalogo.gestionar')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Editar una franja (parcial); isActive:true la reactiva',
  })
  @ApiOkResponse({ type: TimeSlotResponseDto })
  @ApiBadRequestResponse({
    description: 'Datos inválidos o rango con inicio >= fin',
  })
  @ApiNotFoundResponse({
    description: 'La franja no existe o es de otra distribuidora',
  })
  @ApiConflictResponse({
    description:
      'El nuevo horario se solapa con otra franja activa, el nombre ya lo tiene otra activa, o la capacidad queda por debajo de lo agendado',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTimeSlotDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TimeSlotResponseDto> {
    return TimeSlotMapper.toDto(
      await this.timeSlotService.update(id, dto, distributorId),
    );
  }

  @Delete(':id')
  @Permiso('catalogo.gestionar')
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Deactivate time slot' })
  @ApiOkResponse({ type: TimeSlotResponseDto })
  @ApiNotFoundResponse({
    description: 'La franja no existe o es de otra distribuidora',
  })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TimeSlotResponseDto> {
    return TimeSlotMapper.toDto(
      await this.timeSlotService.remove(id, distributorId),
    );
  }
}
