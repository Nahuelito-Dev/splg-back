import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { CarService } from './car.service';
import { Car } from './entities/car.entity';
import { DeliveryService } from '../delivery/delivery.service';

/**
 * Un vehículo se asigna a un chofer de la misma distribuidora, su patente no
 * se repite y un admin sólo ve y toca los de su distribuidora.
 */
describe('CarService', () => {
  let service: CarService;
  let cars: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    softRemove: jest.Mock;
  };
  let deliveries: { findDistributorIdByUserId: jest.Mock };

  const dto = { user_id: 'u1', car_patent: 'AB123CD' };

  beforeEach(() => {
    cars = {
      findOne: jest.fn(),
      create: jest.fn((c: Partial<Car>) => c),
      save: jest.fn((c: Car) => Promise.resolve(c)),
      softRemove: jest.fn(),
    };
    deliveries = {
      findDistributorIdByUserId: jest.fn().mockResolvedValue('d1'),
    };
    service = new CarService(
      cars as unknown as Repository<Car>,
      deliveries as unknown as DeliveryService,
    );
  });

  it('se crea en la distribuidora del admin', async () => {
    cars.findOne.mockResolvedValue(null);
    const c = await service.create(dto, 'd1');
    expect(c).toMatchObject({ user_id: 'u1', distributor_id: 'd1' });
  });

  it('el dueño tiene que ser chofer', async () => {
    deliveries.findDistributorIdByUserId.mockResolvedValue(null);
    await expect(service.create(dto, 'd1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('no se le asigna a un chofer de otra distribuidora', async () => {
    deliveries.findDistributorIdByUserId.mockResolvedValue('d2');
    await expect(service.create(dto, 'd1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('al editar, no se pasa a un chofer de otra distribuidora', async () => {
    cars.findOne.mockResolvedValue({ car_id: 'c1', user_id: 'u1' });
    deliveries.findDistributorIdByUserId.mockResolvedValue('d2');
    await expect(
      service.update('c1', { user_id: 'u2' }, 'd1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('al editar, la patente nueva no puede ser la de otro auto', async () => {
    cars.findOne
      .mockResolvedValueOnce({ car_id: 'c1', car_patent: 'AA111AA' })
      .mockResolvedValueOnce({ car_id: 'c2', car_patent: 'BB222BB' });
    await expect(
      service.update('c1', { car_patent: 'BB222BB' }, 'd1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('la patente no se repite', async () => {
    cars.findOne.mockResolvedValue({ car_id: 'otro' });
    await expect(service.create(dto, 'd1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('un admin no ve vehículos de otra distribuidora', async () => {
    cars.findOne.mockResolvedValue(null);
    await expect(service.findOne('c1', 'd2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(cars.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { car_id: 'c1', distributor_id: 'd2' },
      }),
    );
  });

  it('la baja responde con el id borrado', async () => {
    cars.findOne.mockResolvedValue({ car_id: 'c1' });
    await expect(service.remove('c1', 'd1')).resolves.toEqual({
      message: 'Car deleted successfully',
      carId: 'c1',
    });
  });
});
