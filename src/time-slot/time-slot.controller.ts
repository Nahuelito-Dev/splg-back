import { Controller, Get, Post, Body, Param, Delete, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { TimeSlotService } from './time-slot.service';
import { CreateTimeSlotDto } from './dto/create-time-slot.dto';
import { Public } from '../common/decorators/isPublic.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RoleType } from '../common/constants/role-type.enum';

@ApiTags('Time Slots')
@Controller('time-slot')
export class TimeSlotController {
    constructor(private readonly timeSlotService: TimeSlotService) { }

    @Post()
    @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
    @ApiOperation({ summary: 'Create a new time slot' })
    create(@Body() createTimeSlotDto: CreateTimeSlotDto) {
        return this.timeSlotService.create(createTimeSlotDto);
    }

    @Get()
    @Public()
    @ApiOperation({ summary: 'List all active time slots' })
    findAll() {
        return this.timeSlotService.findAll();
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get time slot by ID' })
    findOne(@Param('id', ParseUUIDPipe) id: string) {
        return this.timeSlotService.findOne(id);
    }

    @Delete(':id')
    @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
    @ApiOperation({ summary: 'Deactivate time slot' })
    remove(@Param('id', ParseUUIDPipe) id: string) {
        return this.timeSlotService.remove(id);
    }
}
