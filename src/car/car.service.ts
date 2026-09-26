import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository, FindOptionsWhere } from 'typeorm';
import { Car } from './entities/car.entity';
import { CreateCarDto } from './dto/create-car.dto';
import { UpdateCarDto } from './dto/update-car.dto';
import { DeliveryService } from '../delivery/delivery.service';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { sinIndefinidos } from '../common/utils/sin-indefinidos.util';
import { CarBorradoResponseDto } from './dto/car-response.dto';

/**
 * El cuerpo de la API va en snake_case y la entidad en camelCase: se mapea
 * campo por campo. Volcar el DTO entero (`...dto`) no da error de tipos y
 * pierde los datos en silencio.
 */
function columnasDelAuto(dto: UpdateCarDto): DeepPartial<Car> {
  return sinIndefinidos({
    userId: dto.user_id,
    typeCar: dto.type_car,
    carCapacity: dto.car_capacity,
    carPatent: dto.car_patent,
    carBrand: dto.car_brand,
    carModel: dto.car_model,
    carYear: dto.car_year,
    carColor: dto.car_color,
  });
}

@Injectable()
export class CarService {
  private readonly logger = new Logger(CarService.name);

  constructor(
    @InjectRepository(Car)
    private readonly carRepository: Repository<Car>,

    private readonly deliveryService: DeliveryService,
  ) {}

  async create(
    createCarDto: CreateCarDto,
    distributorId: string,
  ): Promise<Car> {
    await this.assertDueñoEsChofer(createCarDto.user_id, distributorId);

    if (createCarDto.car_patent) {
      const existingCar = await this.carRepository.findOne({
        where: { carPatent: createCarDto.car_patent },
      });

      if (existingCar) {
        throw new BadRequestException(
          'La patente del vehículo ya está registrada',
        );
      }
    }

    const car = this.carRepository.create({
      ...columnasDelAuto(createCarDto),
      distributorId,
    });

    return await this.carRepository.save(car);
  }

  async findAll(distributorId?: string): Promise<Car[]> {
    const where: FindOptionsWhere<Car> = {};
    if (distributorId) where.distributorId = distributorId;

    return await this.carRepository.find({
      where,
      relations: ['user', 'user.delivery'],
    });
  }

  /**
   * `distributorId` opcional: si viene, el auto debe pertenecer a ese tenant
   * (evita que un admin lea/edite vehículos de otra distribuidora).
   */
  async findOne(id: string, distributorId?: string | null): Promise<Car> {
    const where: FindOptionsWhere<Car> = { carId: id };
    if (distributorId) where.distributorId = distributorId;

    const car = await this.carRepository.findOne({
      where,
      relations: ['user', 'user.delivery'],
    });

    if (!car) {
      throw new NotFoundException(`Car with ID: ${id} not found`);
    }

    return car;
  }

  async findByUserId(
    userId: string,
    distributorId?: string | null,
  ): Promise<Car[]> {
    const where: FindOptionsWhere<Car> = { userId };
    if (distributorId) where.distributorId = distributorId;

    const cars = await this.carRepository.find({
      where,
      relations: ['user'],
    });

    return cars;
  }

  async update(
    id: string,
    updateCarDto: UpdateCarDto,
    distributorId: string,
  ): Promise<Car> {
    // Verifica pertenencia al tenant antes de editar.
    const actual = await this.findOne(id, distributorId);

    if (updateCarDto.user_id && updateCarDto.user_id !== actual.userId) {
      await this.assertDueñoEsChofer(updateCarDto.user_id, distributorId);
    }

    // Contra la patente guardada: después del preload el auto ya trae la
    // nueva y la comparación daba siempre igual.
    if (
      updateCarDto.car_patent &&
      updateCarDto.car_patent !== actual.carPatent
    ) {
      const existingCar = await this.carRepository.findOne({
        where: { carPatent: updateCarDto.car_patent },
      });

      if (existingCar && existingCar.carId !== id) {
        throw new BadRequestException(
          'La patente del vehículo ya está registrada',
        );
      }
    }

    const car = await this.carRepository.preload({
      carId: id,
      ...columnasDelAuto(updateCarDto),
    });

    if (!car) {
      throw new NotFoundException(`Car with ID: ${id} not found`);
    }

    return await this.carRepository.save(car);
  }

  async remove(
    id: string,
    distributorId: string,
  ): Promise<CarBorradoResponseDto> {
    const car = await this.findOne(id, distributorId);
    await this.carRepository.softRemove(car);

    return {
      message: 'Car deleted successfully',
      carId: id,
    };
  }

  async findByPatent(
    patent: string,
    distributorId?: string | null,
  ): Promise<Car | null> {
    const where: FindOptionsWhere<Car> = { carPatent: patent };
    if (distributorId) where.distributorId = distributorId;

    const car = await this.carRepository.findOne({
      where,
      relations: ['user', 'user.delivery'],
    });

    return car;
  }

  /**
   * Delega en el traductor compartido. Antes cada servicio tenia su propia
   * copia: contemplaban uno o dos codigos de Postgres y convertian todo lo
   * demas en un 500 sin registrar la causa, asi que el mensaje mandaba a
   * mirar unos logs donde el error no estaba.
   */
  private handleDBExceptions(error: unknown): never {
    return traducirErrorDeBase(error, this.logger, 'autos');
  }

  /**
   * H-69: el dueño de un vehículo es un chofer de la misma distribuidora. Un
   * usuario que no es chofer, o que lo es de otra, se trata como inexistente.
   */
  private async assertDueñoEsChofer(
    userId: string,
    distributorId: string,
  ): Promise<void> {
    const suDistribuidora =
      await this.deliveryService.findDistributorIdByUserId(userId);
    if (suDistribuidora !== distributorId) {
      throw new NotFoundException(
        `No hay un chofer con user ID ${userId} en esta distribuidora`,
      );
    }
  }
}
