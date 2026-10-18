import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Car, FleetStatus } from '../car/entities/car.entity';
import { CarService } from '../car/car.service';
import { FleetTaskService } from './fleet-task.service';
import { traducirErrorDeBase } from '../common/errors/db-exceptions';

/**
 * CU-247: el camino de vuelta de un vehículo fuera de servicio (siniestro,
 * CU-201, o el planificador de flota, CU-105). Comparte con la asignación a un
 * chofer el control de documentación (`FleetTaskService`): no hay dos reglas
 * de habilitación. Reactivar no asigna el vehículo a nadie.
 */
@Injectable()
export class FleetVehicleStatusService {
  private readonly logger = new Logger(FleetVehicleStatusService.name);

  constructor(
    private readonly cars: CarService,
    private readonly tasks: FleetTaskService,
    private readonly dataSource: DataSource,
  ) {}

  async reactivar(carId: string, distributorId: string): Promise<Car> {
    const car = await this.cars.findOne(carId, distributorId); // 404
    if (car.fleetStatus !== FleetStatus.GROUNDED) {
      throw new ConflictException('El vehículo no está fuera de servicio');
    }

    const motivos = await this.tasks.motivosDeInhabilitacionDeVehiculo(
      carId,
      distributorId,
    );
    if (motivos.length > 0) {
      throw new BadRequestException(
        `No se puede reactivar: ${motivos.join('; ')}.`,
      );
    }

    try {
      return await this.dataSource.transaction((manager) =>
        this.cars.cambiarEstadoDeFlota(
          manager,
          carId,
          distributorId,
          FleetStatus.ACTIVE,
          FleetStatus.GROUNDED,
        ),
      );
    } catch (error) {
      return traducirErrorDeBase(error, this.logger, 'reactivar vehículo');
    }
  }
}
