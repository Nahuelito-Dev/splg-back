import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
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
import { Public } from '../common/decorators/isPublic.decorator';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
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
      '?distributor lo overridea para super_admin)',
  })
  @ApiOkResponse({ type: TimeSlotResponseDto, isArray: true })
  async findAll(
    @CurrentDistributor() distributorId: string | null,
    @Query() { distributor }: ListarFranjasQueryDto,
  ): Promise<TimeSlotResponseDto[]> {
    const slots = await this.timeSlotService.findAll(
      distributor,
      distributorId,
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
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<TimeSlotResponseDto> {
    return TimeSlotMapper.toDto(
      await this.timeSlotService.findOne(id, distributorId),
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
