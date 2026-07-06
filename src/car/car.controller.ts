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
  create(@Body() createCarDto: CreateCarDto) {
    return this.carService.create(createCarDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all cars' })
  @ApiResponse({ status: 200, description: 'List of cars' })
  findAll() {
    return this.carService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get car by ID' })
  @ApiParam({ name: 'id', description: 'Car UUID' })
  @ApiResponse({ status: 200, description: 'Car found' })
  @ApiResponse({ status: 404, description: 'Car not found' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.carService.findOne(id);
  }

  @Get('user/:userId')
  @ApiOperation({ summary: 'Get cars by user ID' })
  @ApiParam({ name: 'userId', description: 'User UUID' })
  @ApiResponse({ status: 200, description: 'List of user cars' })
  findByUserId(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.carService.findByUserId(userId);
  }

  @Get('patent/:patent')
  @ApiOperation({ summary: 'Get car by patent' })
  @ApiParam({ name: 'patent', description: 'Car patent number' })
  @ApiResponse({ status: 200, description: 'Car found' })
  findByPatent(@Param('patent') patent: string) {
    return this.carService.findByPatent(patent);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update car by ID' })
  @ApiParam({ name: 'id', description: 'Car UUID' })
  @ApiResponse({ status: 200, description: 'Car updated successfully' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateCarDto: UpdateCarDto,
  ) {
    return this.carService.update(id, updateCarDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete car by ID' })
  @ApiParam({ name: 'id', description: 'Car UUID' })
  @ApiResponse({ status: 200, description: 'Car deleted successfully' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.carService.remove(id);
  }
}
