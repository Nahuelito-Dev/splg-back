import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CarService } from './car.service';
import { CarMapper } from './car.mapper';
import { CreateCarDto } from './dto/create-car.dto';
import { UpdateCarDto } from './dto/update-car.dto';
import { PatenteParamDto } from './dto/patente-param.dto';
import { CarBorradoResponseDto, CarResponseDto } from './dto/car-response.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';

@ApiTags('Cars')
@ApiBearerAuth()
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('car')
export class CarController {
  constructor(private readonly carService: CarService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new car' })
  @ApiCreatedResponse({ type: CarResponseDto })
  @ApiBadRequestResponse({ description: 'La patente ya está registrada' })
  @ApiNotFoundResponse({ description: 'El usuario no existe' })
  async create(
    @Body() createCarDto: CreateCarDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CarResponseDto> {
    return CarMapper.toDto(
      await this.carService.create(createCarDto, distributorId),
    );
  }

  @Get()
  @ApiOperation({ summary: 'Get all cars' })
  @ApiOkResponse({ type: CarResponseDto, isArray: true })
  async findAll(
    @CurrentDistributor() distributorId: string | null,
  ): Promise<CarResponseDto[]> {
    const cars = await this.carService.findAll(distributorId ?? undefined);
    return cars.map((c) => CarMapper.toDto(c));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get car by ID' })
  @ApiParam({ name: 'id', description: 'Car UUID' })
  @ApiOkResponse({ type: CarResponseDto })
  @ApiNotFoundResponse({ description: 'Car not found' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<CarResponseDto> {
    return CarMapper.toDto(await this.carService.findOne(id, distributorId));
  }

  @Get('user/:userId')
  @ApiOperation({ summary: 'Get cars by user ID' })
  @ApiParam({ name: 'userId', description: 'User UUID' })
  @ApiOkResponse({ type: CarResponseDto, isArray: true })
  async findByUserId(
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<CarResponseDto[]> {
    const cars = await this.carService.findByUserId(userId, distributorId);
    return cars.map((c) => CarMapper.toDto(c));
  }

  @Get('patent/:patent')
  @ApiOperation({ summary: 'Get car by patent' })
  @ApiOkResponse({
    type: CarResponseDto,
    description: 'Sin cuerpo si no hay un vehículo con esa patente',
  })
  async findByPatent(
    @Param() { patent }: PatenteParamDto,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<CarResponseDto | null> {
    const car = await this.carService.findByPatent(patent, distributorId);
    return car ? CarMapper.toDto(car) : null;
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update car by ID' })
  @ApiParam({ name: 'id', description: 'Car UUID' })
  @ApiOkResponse({ type: CarResponseDto })
  @ApiNotFoundResponse({ description: 'Car not found' })
  @ApiBadRequestResponse({ description: 'La patente ya está registrada' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateCarDto: UpdateCarDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CarResponseDto> {
    return CarMapper.toDto(
      await this.carService.update(id, updateCarDto, distributorId),
    );
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete car by ID' })
  @ApiParam({ name: 'id', description: 'Car UUID' })
  @ApiOkResponse({ type: CarBorradoResponseDto })
  @ApiNotFoundResponse({ description: 'Car not found' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CarBorradoResponseDto> {
    return this.carService.remove(id, distributorId);
  }
}
