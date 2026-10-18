import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CarService } from '../car/car.service';
import { FleetStatus } from '../car/entities/car.entity';
import { FleetTaskService } from './fleet-task.service';
import { FleetVehicleStatusService } from './fleet-vehicle-status.service';

describe('FleetVehicleStatusService (CU-247)', () => {
  let service: FleetVehicleStatusService;
  let cars: { findOne: jest.Mock; cambiarEstadoDeFlota: jest.Mock };
  let tasks: { motivosDeInhabilitacionDeVehiculo: jest.Mock };

  beforeEach(() => {
    cars = {
      findOne: jest
        .fn()
        .mockResolvedValue({ carId: 'c1', fleetStatus: FleetStatus.GROUNDED }),
      cambiarEstadoDeFlota: jest
        .fn()
        .mockResolvedValue({ carId: 'c1', fleetStatus: FleetStatus.ACTIVE }),
    };
    tasks = {
      motivosDeInhabilitacionDeVehiculo: jest.fn().mockResolvedValue([]),
    };
    const dataSource = {
      transaction: jest.fn((cb: (m: unknown) => unknown) => cb({})),
    };
    service = new FleetVehicleStatusService(
      cars as unknown as CarService,
      tasks as unknown as FleetTaskService,
      dataSource as unknown as DataSource,
    );
  });

  it('pasa de fuera de servicio a activo con la documentación en regla', async () => {
    const car = await service.reactivar('c1', 'd1');
    expect(car.fleetStatus).toBe(FleetStatus.ACTIVE);
    expect(cars.cambiarEstadoDeFlota).toHaveBeenCalledWith(
      expect.anything(),
      'c1',
      'd1',
      FleetStatus.ACTIVE,
      FleetStatus.GROUNDED,
    );
  });

  it('un vehículo de otra distribuidora es 404', async () => {
    cars.findOne.mockRejectedValue(new NotFoundException());
    await expect(service.reactivar('c1', 'd1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('si no está fuera de servicio es 409 y no mira la documentación', async () => {
    cars.findOne.mockResolvedValue({
      carId: 'c1',
      fleetStatus: FleetStatus.ACTIVE,
    });
    await expect(service.reactivar('c1', 'd1')).rejects.toThrow(
      new ConflictException('El vehículo no está fuera de servicio'),
    );
    expect(tasks.motivosDeInhabilitacionDeVehiculo).not.toHaveBeenCalled();
  });

  it('con documentación bloqueante vencida rechaza e indica cuál, usando el mismo control que la asignación', async () => {
    tasks.motivosDeInhabilitacionDeVehiculo.mockResolvedValue([
      'VTV: venció el 01/09/2026',
    ]);
    await expect(service.reactivar('c1', 'd1')).rejects.toThrow(
      new BadRequestException(
        'No se puede reactivar: VTV: venció el 01/09/2026.',
      ),
    );
    expect(cars.cambiarEstadoDeFlota).not.toHaveBeenCalled();
  });
});
