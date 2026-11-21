import { Repository } from 'typeorm';
import { Car } from '../../car/entities/car.entity';
import { EntityPhotoService } from '../../s3/entity-photo.service';
import type { OrderResponseDto } from '../dto/order-response.dto';
import { OrderVehiclePhotoService } from './order-vehicle-photo.service';

const pedido = (
  id: string,
  carId: string | null,
  distributorId = 'd1',
): OrderResponseDto =>
  ({
    id,
    distributorId,
    vehicle: carId
      ? { carId, patent: null, brand: null, model: null, photoUrl: null }
      : null,
  }) as unknown as OrderResponseDto;

const auto = (carId: string, photoKey: string | null, distributorId = 'd1') =>
  ({ carId, photoKey, distributorId }) as Car;

describe('OrderVehiclePhotoService', () => {
  let cars: { find: jest.Mock };
  let fotos: { urlDe: jest.Mock };
  let service: OrderVehiclePhotoService;

  beforeEach(() => {
    cars = { find: jest.fn().mockResolvedValue([]) };
    fotos = {
      urlDe: jest.fn((key: string | null) =>
        Promise.resolve(key ? `https://s3.test/${key}` : null),
      ),
    };
    service = new OrderVehiclePhotoService(
      cars as unknown as Repository<Car>,
      fotos as unknown as EntityPhotoService,
    );
  });

  it('con foto: el vehículo del pedido lleva la URL firmada del auto', async () => {
    cars.find.mockResolvedValue([auto('c1', 'cars/d1/c1/x.jpg')]);
    const p = pedido('o1', 'c1');
    await service.completar([p]);
    expect(p.vehicle?.photoUrl).toBe('https://s3.test/cars/d1/c1/x.jpg');
  });

  it('sin foto: photoUrl null', async () => {
    cars.find.mockResolvedValue([auto('c1', null)]);
    const p = pedido('o1', 'c1');
    await service.completar([p]);
    expect(p.vehicle?.photoUrl).toBeNull();
  });

  it('auto borrado o dado de baja (no vuelve en la lectura): photoUrl null y el pedido sigue', async () => {
    const p = pedido('o1', 'c1');
    await service.completar([p]);
    expect(p.vehicle).toEqual({
      carId: 'c1',
      patent: null,
      brand: null,
      model: null,
      photoUrl: null,
    });
  });

  it('un auto de otra distribuidora no regala su foto', async () => {
    cars.find.mockResolvedValue([auto('c1', 'k.jpg', 'otra')]);
    const p = pedido('o1', 'c1', 'd1');
    await service.completar([p]);
    expect(p.vehicle?.photoUrl).toBeNull();
  });

  it('en una lista lee los autos una sola vez (sin N+1) y firma cada auto una vez', async () => {
    cars.find.mockResolvedValue([auto('c1', 'a.jpg'), auto('c2', null)]);
    const lista = [
      pedido('o1', 'c1'),
      pedido('o2', 'c1'),
      pedido('o3', 'c2'),
      pedido('o4', null),
    ];
    await service.completar(lista);
    expect(cars.find).toHaveBeenCalledTimes(1);
    expect(fotos.urlDe).toHaveBeenCalledTimes(2);
    expect(lista.map((p) => p.vehicle?.photoUrl ?? null)).toEqual([
      'https://s3.test/a.jpg',
      'https://s3.test/a.jpg',
      null,
      null,
    ]);
  });

  it('sin pedidos con vehículo no consulta nada', async () => {
    await service.completar([pedido('o1', null)]);
    expect(cars.find).not.toHaveBeenCalled();
  });
});
