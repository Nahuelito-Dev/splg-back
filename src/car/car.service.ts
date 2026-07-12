import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere } from 'typeorm';
import { Car } from './entities/car.entity';
import { CreateCarDto } from './dto/create-car.dto';
import { UpdateCarDto } from './dto/update-car.dto';
import { User } from '../users/entities/user.entity';

@Injectable()
export class CarService {
  constructor(
    @InjectRepository(Car)
    private readonly carRepository: Repository<Car>,

    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async create(createCarDto: CreateCarDto, distributorId: string) {
    const user = await this.userRepository.findOne({
      where: { user_id: createCarDto.user_id },
    });

    if (!user) {
      throw new NotFoundException(
        `User with ID: ${createCarDto.user_id} not found`,
      );
    }

    if (createCarDto.car_patent) {
      const existingCar = await this.carRepository.findOne({
        where: { car_patent: createCarDto.car_patent },
      });

      if (existingCar) {
        throw new BadRequestException(
          'La patente del vehículo ya está registrada',
        );
      }
    }

    const car = this.carRepository.create({
      ...createCarDto,
      user_id: createCarDto.user_id,
      distributor_id: distributorId,
    });

    return await this.carRepository.save(car);
  }

  async findAll(distributorId?: string) {
    const where: FindOptionsWhere<Car> = {};
    if (distributorId) where.distributor_id = distributorId;

    return await this.carRepository.find({
      where,
      relations: ['user', 'user.delivery'],
    });
  }

  /**
   * `distributorId` opcional: si viene, el auto debe pertenecer a ese tenant
   * (evita que un admin lea/edite vehículos de otra distribuidora).
   */
  async findOne(id: string, distributorId?: string | null) {
    const where: FindOptionsWhere<Car> = { car_id: id };
    if (distributorId) where.distributor_id = distributorId;

    const car = await this.carRepository.findOne({
      where,
      relations: ['user', 'user.delivery'],
    });

    if (!car) {
      throw new NotFoundException(`Car with ID: ${id} not found`);
    }

    return car;
  }

  async findByUserId(userId: string, distributorId?: string | null) {
    const where: FindOptionsWhere<Car> = { user_id: userId };
    if (distributorId) where.distributor_id = distributorId;

    const cars = await this.carRepository.find({
      where,
      relations: ['user'],
    });

    return cars;
  }

  async update(id: string, updateCarDto: UpdateCarDto, distributorId: string) {
    // Verifica pertenencia al tenant antes de editar.
    await this.findOne(id, distributorId);

    const car = await this.carRepository.preload({
      car_id: id,
      ...updateCarDto,
    });

    if (!car) {
      throw new NotFoundException(`Car with ID: ${id} not found`);
    }

    if (updateCarDto.car_patent && updateCarDto.car_patent !== car.car_patent) {
      const existingCar = await this.carRepository.findOne({
        where: { car_patent: updateCarDto.car_patent },
      });

      if (existingCar && existingCar.car_id !== id) {
        throw new BadRequestException(
          'La patente del vehículo ya está registrada',
        );
      }
    }

    return await this.carRepository.save(car);
  }

  async remove(id: string, distributorId: string) {
    const car = await this.findOne(id, distributorId);
    await this.carRepository.remove(car);

    return {
      message: 'Car deleted successfully',
      carId: id,
    };
  }

  async findByPatent(patent: string, distributorId?: string | null) {
    const where: FindOptionsWhere<Car> = { car_patent: patent };
    if (distributorId) where.distributor_id = distributorId;

    const car = await this.carRepository.findOne({
      where,
      relations: ['user', 'user.delivery'],
    });

    return car;
  }

  private handleDBExceptions(error: any) {
    if (error.code === '23505') {
      throw new BadRequestException('Duplicate entry', error.detail);
    }

    if (error.code === '23503') {
      throw new BadRequestException('Foreign key constraint failed');
    }

    throw new InternalServerErrorException(
      'Unexpected error, check server logs',
    );
  }
}
