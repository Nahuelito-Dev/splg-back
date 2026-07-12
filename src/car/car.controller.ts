// src/car/car.controller.ts - VERSIÓN COMPLETA
import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { CarService } from './car.service';
import { CreateCarDto } from './dto/create-car.dto';
import { UpdateCarDto } from './dto/update-car.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';

@ApiTags('Cars')
@ApiBearerAuth()
@Roles(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('car')
export class CarController {
  constructor(private readonly carService: CarService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new car' })
  @ApiResponse({ status: 201, description: 'Car created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  create(
    @Body() createCarDto: CreateCarDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ) {
    return this.carService.create(createCarDto, distributorId);
  }

  @Get()
  @ApiOperation({ summary: 'Get all cars' })
  @ApiResponse({ status: 200, description: 'List of cars' })
  findAll(@CurrentDistributor() distributorId: string | null) {
    return this.carService.findAll(distributorId ?? undefined);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get car by ID' })
  @ApiParam({ name: 'id', description: 'Car UUID' })
  @ApiResponse({ status: 200, description: 'Car found' })
  @ApiResponse({ status: 404, description: 'Car not found' })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ) {
    return this.carService.findOne(id, distributorId);
  }

  @Get('user/:userId')
  @ApiOperation({ summary: 'Get cars by user ID' })
  @ApiParam({ name: 'userId', description: 'User UUID' })
  @ApiResponse({ status: 200, description: 'List of user cars' })
  findByUserId(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentDistributor() distributorId: string | null,
  ) {
    return this.carService.findByUserId(userId, distributorId);
  }

  @Get('patent/:patent')
  @ApiOperation({ summary: 'Get car by patent' })
  @ApiParam({ name: 'patent', description: 'Car patent number' })
  @ApiResponse({ status: 200, description: 'Car found' })
  findByPatent(
    @Param('patent') patent: string,
    @CurrentDistributor() distributorId: string | null,
  ) {
    return this.carService.findByPatent(patent, distributorId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update car by ID' })
  @ApiParam({ name: 'id', description: 'Car UUID' })
  @ApiResponse({ status: 200, description: 'Car updated successfully' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateCarDto: UpdateCarDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ) {
    return this.carService.update(id, updateCarDto, distributorId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete car by ID' })
  @ApiParam({ name: 'id', description: 'Car UUID' })
  @ApiResponse({ status: 200, description: 'Car deleted successfully' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ) {
    return this.carService.remove(id, distributorId);
  }
}
