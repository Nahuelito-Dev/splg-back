import { Controller, Get, Post, Body, Param, Delete, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { TimeSlotService } from './time-slot.service';
import { CreateTimeSlotDto } from './dto/create-time-slot.dto';
import { Public } from '../common/decorators/isPublic.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';

@ApiTags('Time Slots')
@Controller('time-slot')
export class TimeSlotController {
    constructor(private readonly timeSlotService: TimeSlotService) { }

    @Post()
    @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
    @ApiOperation({ summary: 'Create a new time slot' })
    create(
        @Body() createTimeSlotDto: CreateTimeSlotDto,
        @CurrentDistributor({ required: true }) distributorId: string,
    ) {
        return this.timeSlotService.create(createTimeSlotDto, distributorId);
    }

    @Get()
    @Public()
    @ApiOperation({ summary: 'List all active time slots' })
    findAll(@Query('distributor') distributor?: string) {
        return this.timeSlotService.findAll(distributor);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get time slot by ID' })
    findOne(
        @Param('id', ParseUUIDPipe) id: string,
        @CurrentDistributor() distributorId: string | null,
    ) {
        return this.timeSlotService.findOne(id, distributorId);
    }

    @Delete(':id')
    @Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
    @ApiOperation({ summary: 'Deactivate time slot' })
    remove(
        @Param('id', ParseUUIDPipe) id: string,
        @CurrentDistributor({ required: true }) distributorId: string,
    ) {
        return this.timeSlotService.remove(id, distributorId);
    }
}
