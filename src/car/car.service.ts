import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DeepPartial,
  EntityManager,
  Repository,
  FindOptionsWhere,
} from 'typeorm';
import { Car, FleetStatus } from './entities/car.entity';
import { CreateCarDto } from './dto/create-car.dto';
import { UpdateCarDto } from './dto/update-car.dto';
import { DeliveryService } from '../delivery/delivery.service';
import { VehicleAssignmentService } from './vehicle-assignment.service';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';
import { sinIndefinidos } from '../common/utils/sin-indefinidos.util';
import { CarBorradoResponseDto } from './dto/car-response.dto';
import { normalizarPatente } from './patente.util';

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
    carPatent:
      typeof dto.car_patent === 'string'
        ? normalizarPatente(dto.car_patent)
        : dto.car_patent,
    carBrand: dto.car_brand,
    carModel: dto.car_model,
    carYear: dto.car_year,
    carColor: dto.car_color,
    fuelType: dto.fuel_type,
    tankCapacityLiters: dto.tank_capacity_liters,
  });
}

@Injectable()
export class CarService {
  private readonly logger = new Logger(CarService.name);

  constructor(
    @InjectRepository(Car)
    private readonly carRepository: Repository<Car>,

    private readonly deliveryService: DeliveryService,
    private readonly vehicleAssignments: VehicleAssignmentService,
  ) {}

  async create(
    createCarDto: CreateCarDto,
    distributorId: string,
  ): Promise<Car> {
    await this.assertDueñoEsChofer(createCarDto.user_id, distributorId);

    if (typeof createCarDto.car_patent === 'string') {
      const existingCar = await this.carRepository.findOne({
        where: { carPatent: normalizarPatente(createCarDto.car_patent) },
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
      throw new NotFoundException(`Vehículo ${id} no encontrado`);
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
    // `''` no se saltea el chequeo (la validación del DTO ya lo rechaza, pero
    // este servicio también lo llaman otros) y `null` borra la patente.
    const patenteNueva =
      typeof updateCarDto.car_patent === 'string'
        ? normalizarPatente(updateCarDto.car_patent)
        : undefined;
    if (patenteNueva !== undefined && patenteNueva !== actual.carPatent) {
      const existingCar = await this.carRepository.findOne({
        where: { carPatent: patenteNueva },
      });

      if (existingCar && existingCar.carId !== id) {
        throw new BadRequestException(
          'La patente del vehículo ya está registrada',
        );
      }
    }

    // `car_patent: null` también es un cambio: borra la patente.
    const cambiaPatente =
      updateCarDto.car_patent === null
        ? actual.carPatent !== null
        : patenteNueva !== undefined && patenteNueva !== actual.carPatent;
    const cambiaIdentidad =
      cambiaPatente ||
      (updateCarDto.type_car !== undefined &&
        updateCarDto.type_car !== actual.typeCar);

    if (!cambiaIdentidad) {
      const car = await this.carRepository.preload({
        carId: id,
        ...columnasDelAuto(updateCarDto),
      });
      if (!car) {
        throw new NotFoundException(`Vehículo ${id} no encontrado`);
      }
      return await this.carRepository.save(car);
    }

    // La patente y el tipo definen la identidad y la aptitud del vehículo: no
    // se tocan mientras un chofer lo usa. Con la fila bloqueada (el mismo lock
    // que `remove` y `VehicleAssignmentService.ponerEnUso`) la verificación y
    // el cambio son atómicos frente a un `PUT /delivery/:id/vehicle`.
    try {
      return await this.carRepository.manager.transaction(async (manager) => {
        const bloqueado = await manager
          .getRepository(Car)
          .createQueryBuilder('car')
          .setLock('pessimistic_write')
          .where('car.carId = :id', { id })
          .andWhere('car.distributorId = :distributorId', { distributorId })
          .getOne();
        if (!bloqueado) {
          throw new NotFoundException(`Vehículo ${id} no encontrado`);
        }
        await this.vehicleAssignments.assertVehiculoLibre(id, manager);
        const car = await manager.getRepository(Car).preload({
          carId: id,
          ...columnasDelAuto(updateCarDto),
        });
        if (!car) {
          throw new NotFoundException(`Vehículo ${id} no encontrado`);
        }
        return await manager.getRepository(Car).save(car);
      });
    } catch (error) {
      return this.handleDBExceptions(error);
    }
  }

  async remove(
    id: string,
    distributorId: string,
  ): Promise<CarBorradoResponseDto> {
    await this.findOne(id, distributorId); // 404 si no es de esta distribuidora

    // Con la fila del vehículo bloqueada (el mismo lock que toma
    // `VehicleAssignmentService.ponerEnUso`), verificar que está libre y darlo
    // de baja es atómico: un `PUT /delivery/:id/vehicle` concurrente espera y,
    // si la baja gana, no encuentra el vehículo (404); si gana el `PUT`, la
    // baja ve el vehículo en uso y responde 409.
    try {
      await this.carRepository.manager.transaction(async (manager) => {
        const car = await manager
          .getRepository(Car)
          .createQueryBuilder('car')
          .setLock('pessimistic_write')
          .where('car.carId = :id', { id })
          .andWhere('car.distributorId = :distributorId', { distributorId })
          .getOne();
        if (!car) {
          throw new NotFoundException(`Vehículo ${id} no encontrado`);
        }
        // No se puede dar de baja un vehículo en uso: hay que liberarlo
        // primero (`DELETE /delivery/:id/vehicle`).
        await this.vehicleAssignments.assertVehiculoLibre(id, manager);
        await manager.softRemove(car);
      });
    } catch (error) {
      return this.handleDBExceptions(error);
    }

    return {
      message: 'Car deleted successfully',
      carId: id,
    };
  }

  /**
   * Único punto que escribe el kilometraje del vehículo: lo comparten las
   * cargas de combustible y el cierre de las tareas de mantenimiento, y cada
   * uno sólo lo sube (`GREATEST`), así uno no pisa al otro aunque lleguen a la
   * vez. Lo baja `bajarOdometro`, y sólo cuando el valor lo puso una carga que
   * se anula o se corrige.
   */
  async actualizarOdometro(
    manager: EntityManager,
    carId: string,
    km: number,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(Car)
      .set({ odometerKm: () => 'GREATEST(COALESCE("odometer_km", 0), :km)' })
      .where('car_id = :carId', { carId })
      .setParameter('km', km)
      .execute();
  }

  /**
   * Si el kilometraje vigente del vehículo es el de la carga que deja de
   * valer (`kmQueDejaDeValer`), lo lleva al de la carga vigente que quede
   * (`kmVigenteRestante`). Si el vehículo ya tenía un valor mayor puesto por
   * otro lado (un cierre de mantenimiento), no lo toca.
   */
  async bajarOdometro(
    manager: EntityManager,
    carId: string,
    kmQueDejaDeValer: number,
    kmVigenteRestante: number | null,
  ): Promise<void> {
    if (kmVigenteRestante === null) return;
    await manager
      .createQueryBuilder()
      .update(Car)
      .set({ odometerKm: kmVigenteRestante })
      .where('car_id = :carId AND odometer_km = :km', {
        carId,
        km: kmQueDejaDeValer,
      })
      .execute();
  }

  /**
   * Toma el lock de la fila del vehículo (el mismo de `remove` y
   * `ponerEnUso`; es el primero en el orden de locks) y responde 404 si no es
   * de la distribuidora. Serializa lo que mira y escribe el kilometraje.
   */
  async bloquear(
    manager: EntityManager,
    carId: string,
    distributorId: string,
  ): Promise<Car> {
    const car = await manager
      .getRepository(Car)
      .createQueryBuilder('car')
      .setLock('pessimistic_write')
      .where('car.carId = :carId', { carId })
      .andWhere('car.distributorId = :distributorId', { distributorId })
      .getOne();
    if (!car) {
      throw new NotFoundException(`Vehículo ${carId} no encontrado`);
    }
    return car;
  }

  /**
   * Cambia el estado de flota con la fila del vehículo bloqueada (el mismo
   * lock que `remove` y `ponerEnUso`). `desde` es el estado que tiene que
   * tener: si otra request lo cambió antes, 409. 404 si no es de la
   * distribuidora. Con `desde` omitido no se exige estado previo.
   */
  async cambiarEstadoDeFlota(
    manager: EntityManager,
    carId: string,
    distributorId: string,
    hacia: FleetStatus,
    desde?: FleetStatus,
  ): Promise<Car> {
    const car = await this.bloquear(manager, carId, distributorId);
    if (desde !== undefined && car.fleetStatus !== desde) {
      throw new ConflictException(
        desde === FleetStatus.GROUNDED
          ? 'El vehículo no está fuera de servicio'
          : 'El vehículo cambió de estado: volvé a intentar',
      );
    }
    car.fleetStatus = hacia;
    return manager.getRepository(Car).save(car);
  }

  async findByPatent(
    patent: string,
    distributorId?: string | null,
  ): Promise<Car | null> {
    const where: FindOptionsWhere<Car> = {
      carPatent: normalizarPatente(patent),
    };
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
