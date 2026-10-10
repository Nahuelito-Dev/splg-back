import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CarService } from './car.service';
import { Car } from './entities/car.entity';
import { CarPhotoService } from './car-photo.service';
import { CarMapper } from './car.mapper';
import { CreateCarDto } from './dto/create-car.dto';
import { UpdateCarDto } from './dto/update-car.dto';
import { PatenteParamDto } from './dto/patente-param.dto';
import { CarBorradoResponseDto, CarResponseDto } from './dto/car-response.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { DownloadQueryDto } from '../s3/dto/download-link.dto';
import {
  ApiSubirFoto,
  ApiVerFoto,
  responderFoto,
  SubirFotoInterceptor,
} from '../s3/photo-http';

@ApiTags('Cars')
@ApiBearerAuth()
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('car')
export class CarController {
  constructor(
    private readonly carService: CarService,
    private readonly carPhoto: CarPhotoService,
  ) {}

  /** El DTO del vehículo (y de su chofer) con las fotos como URL firmada. */
  private async toDto(car: Car): Promise<CarResponseDto> {
    await this.carPhoto.firmar(car);
    return CarMapper.toDto(car);
  }

  private async toDtos(cars: Car[]): Promise<CarResponseDto[]> {
    await this.carPhoto.firmar(cars);
    return cars.map((c) => CarMapper.toDto(c));
  }

  @Post()
  @ApiOperation({ summary: 'Create a new car' })
  @ApiCreatedResponse({ type: CarResponseDto })
  @ApiBadRequestResponse({ description: 'La patente ya está registrada' })
  @ApiNotFoundResponse({ description: 'El usuario no existe' })
  async create(
    @Body() createCarDto: CreateCarDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CarResponseDto> {
    return this.toDto(
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
    return this.toDtos(cars);
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
    return this.toDto(await this.carService.findOne(id, distributorId));
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
    return this.toDtos(cars);
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
    return car ? this.toDto(car) : null;
  }

  @Put(':id/photo')
  @ApiSubirFoto(
    'Subir o reemplazar la foto principal del vehículo',
    CarResponseDto,
  )
  @ApiParam({ name: 'id', description: 'Car UUID' })
  @SubirFotoInterceptor()
  async uploadPhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<CarResponseDto> {
    return this.toDto(await this.carPhoto.subir(id, distributorId, file));
  }

  @Delete(':id/photo')
  @ApiOperation({
    summary: 'Sacar la foto del vehículo',
    description:
      'Quita la referencia (el objeto se borra del bucket en segundo plano); ' +
      'no da de baja el vehículo.',
  })
  @ApiParam({ name: 'id', description: 'Car UUID' })
  @ApiOkResponse({ type: CarResponseDto })
  @ApiNotFoundResponse({ description: 'Car not found' })
  async removePhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDistributor() distributorId: string | null,
  ): Promise<CarResponseDto> {
    return this.toDto(await this.carPhoto.quitar(id, distributorId));
  }

  @Get(':id/photo')
  @ApiVerFoto('Ver la foto del vehículo')
  @ApiParam({ name: 'id', description: 'Car UUID' })
  async getPhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DownloadQueryDto,
    @CurrentDistributor() distributorId: string | null,
    @Res() res: Response,
  ): Promise<void> {
    responderFoto(
      res,
      query.modo,
      await this.carPhoto.enlace(id, distributorId),
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update car by ID' })
  @ApiParam({ name: 'id', description: 'Car UUID' })
  @ApiOkResponse({ type: CarResponseDto })
  @ApiNotFoundResponse({ description: 'Car not found' })
  @ApiBadRequestResponse({ description: 'La patente ya está registrada' })
  @ApiConflictResponse({
    description:
      'El vehículo está en uso por un chofer: no se le cambia la patente ni el tipo',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateCarDto: UpdateCarDto,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CarResponseDto> {
    return this.toDto(
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
