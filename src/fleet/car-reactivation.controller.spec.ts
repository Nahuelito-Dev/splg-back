import { CarPhotoService } from '../car/car-photo.service';
import { Car, FleetStatus } from '../car/entities/car.entity';
import { CarReactivationController } from './car-reactivation.controller';
import { FleetVehicleStatusService } from './fleet-vehicle-status.service';

describe('CarReactivationController', () => {
  it('reactiva y devuelve el vehículo con su foto firmada', async () => {
    const car = {
      carId: 'c1',
      distributorId: 'd1',
      userId: 'u1',
      fleetStatus: FleetStatus.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Car;
    const status = { reactivar: jest.fn().mockResolvedValue(car) };
    const photo = {
      firmar: jest.fn((c: Car) => {
        c.photoSignedUrl = 'https://firmada';
        return Promise.resolve();
      }),
    };
    const controller = new CarReactivationController(
      status as unknown as FleetVehicleStatusService,
      photo as unknown as CarPhotoService,
    );

    const dto = await controller.reactivar('c1', 'd1');

    expect(status.reactivar).toHaveBeenCalledWith('c1', 'd1');
    expect(dto).toMatchObject({
      car_id: 'c1',
      fleet_status: FleetStatus.ACTIVE,
      photoUrl: 'https://firmada',
    });
  });
});
