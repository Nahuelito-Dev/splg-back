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
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';

@ApiTags('Time Slots')
@ApiBearerAuth()
@Controller('time-slot')
export class TimeSlotController {
  constructor(private readonly timeSlotService: TimeSlotService) {}

  @Post()
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create a new time slot' })
  @ApiCreatedResponse({ type: TimeSlotResponseDto })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos (p. ej.: name should not be empty; startTime must be in HH:MM format)',
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
  async findAll(
    @CurrentDistributor() distributorId: string | null,
    @CurrentUser() user: AuthenticatedUser,
    @Query() { distributor, includeInactive }: ListarFranjasQueryDto,
  ): Promise<TimeSlotResponseDto[]> {
    // `?distributor=` es sólo del super admin: un admin queda en su tenant.
    const slots = await this.timeSlotService.findAll(
      user.role === RoleType.SUPER_ADMIN ? distributor : undefined,
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
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<TimeSlotResponseDto> {
    return TimeSlotMapper.toDto(
      await this.timeSlotService.findOne(id, distributorId),
    );
  }

  @Patch(':id')
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
  @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
  @ApiOperation({ summary: 'Deactivate time slot' })
  @ApiOkResponse({ type: TimeSlotResponseDto })
  @ApiNotFoundResponse({
    description: 'La franja no existe o es de otra distribuidora',
  })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<TimeSlotResponseDto> {
    return TimeSlotMapper.toDto(
      await this.timeSlotService.remove(id, distributorId),
    );
  }
}
