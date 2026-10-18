import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { CarService } from '../car/car.service';
import { TireEvent, TireEventType } from './entities/tire-event.entity';
import { Tire, TireStatus } from './entities/tire.entity';
import { TireService } from './tire.service';

describe('TireService', () => {
  let service: TireService;
  let tires: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    exists: jest.Mock;
  };
  let events: { create: jest.Mock; save: jest.Mock };
  let cars: { findOne: jest.Mock; bloquear: jest.Mock };

  const neumatico = (over: Partial<Tire> = {}): Tire =>
    ({
      tireId: 't1',
      distributorId: 'd1',
      status: TireStatus.IN_STOCK,
      carId: null,
      position: null,
      mountedOdometerKm: null,
      kmTraveled: 0,
      retreadCount: 0,
      ...over,
    }) as Tire;

  beforeEach(() => {
    tires = {
      create: jest.fn((t: Partial<Tire>) => t),
      save: jest.fn((t: Tire) => Promise.resolve(t)),
      findOne: jest.fn(),
      exists: jest.fn().mockResolvedValue(false),
    };
    events = {
      create: jest.fn((e: Partial<TireEvent>) => e),
      save: jest.fn((e: TireEvent) => Promise.resolve(e)),
    };
    const manager = {
      getRepository: (entidad: unknown) => (entidad === Tire ? tires : events),
    };
    const dataSource = {
      transaction: jest.fn((cb: (m: unknown) => unknown) => cb(manager)),
    };
    cars = {
      findOne: jest.fn().mockResolvedValue({ carId: 'c1' }),
      bloquear: jest.fn().mockResolvedValue({ carId: 'c1' }),
    };
    service = new TireService(
      tires as unknown as Repository<Tire>,
      events as unknown as Repository<TireEvent>,
      dataSource as unknown as DataSource,
      cars as unknown as CarService,
    );
  });

  describe('registrar', () => {
    const dto = {
      serialNumber: 'S-1',
      brand: 'Pirelli',
      size: '215/75',
      cost: 1000,
    };

    it('nace en depósito', async () => {
      await service.registrar(dto, 'd1');
      expect(tires.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: TireStatus.IN_STOCK,
          distributorId: 'd1',
        }),
      );
    });

    it('la misma serie en la distribuidora es 409 «El neumático ya está registrado»', async () => {
      tires.exists.mockResolvedValue(true);
      await expect(service.registrar(dto, 'd1')).rejects.toThrow(
        new ConflictException('El neumático ya está registrado'),
      );
    });
  });

  describe('registrarMovimiento', () => {
    const mover = (dto: Parameters<TireService['registrarMovimiento']>[1]) =>
      service.registrarMovimiento('t1', dto, 'd1', 'u1');

    beforeEach(() => {
      // tras el movimiento, `findOne` devuelve el neumático ya actualizado
      tires.findOne.mockImplementation(() => Promise.resolve(current));
    });
    let current: Tire;
    const dar = (t: Tire) => {
      current = t;
    };

    it('montar un neumático en depósito lo deja montado en esa posición', async () => {
      dar(neumatico());
      await mover({
        type: TireEventType.MOUNT,
        odometerKm: 1000,
        carId: 'c1',
        position: 'DI',
      });
      expect(current).toMatchObject({
        status: TireStatus.MOUNTED,
        carId: 'c1',
        position: 'DI',
        mountedOdometerKm: 1000,
      });
      expect(events.save).toHaveBeenCalledWith(
        expect.objectContaining({
          type: TireEventType.MOUNT,
          carId: 'c1',
          position: 'DI',
          createdByUserId: 'u1',
        }),
      );
    });

    it('montar uno ya montado es 409 «Movimiento inválido para el estado del neumático»', async () => {
      dar(
        neumatico({ status: TireStatus.MOUNTED, carId: 'c1', position: 'DI' }),
      );
      await expect(
        mover({
          type: TireEventType.MOUNT,
          odometerKm: 1000,
          carId: 'c1',
          position: 'TD',
        }),
      ).rejects.toThrow('Movimiento inválido para el estado del neumático');
      expect(events.save).not.toHaveBeenCalled();
    });

    it('montar sin vehículo o sin posición es 400', async () => {
      dar(neumatico());
      await expect(
        mover({ type: TireEventType.MOUNT, odometerKm: 1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('montar en una posición ocupada es 409', async () => {
      dar(neumatico());
      tires.exists.mockResolvedValue(true);
      await expect(
        mover({
          type: TireEventType.MOUNT,
          odometerKm: 1,
          carId: 'c1',
          position: 'DI',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('desmontar acumula los km del montaje y lo devuelve a depósito', async () => {
      dar(
        neumatico({
          status: TireStatus.MOUNTED,
          carId: 'c1',
          position: 'DI',
          mountedOdometerKm: 1000,
          kmTraveled: 500,
        }),
      );
      await mover({ type: TireEventType.UNMOUNT, odometerKm: 4000 });
      expect(current).toMatchObject({
        status: TireStatus.IN_STOCK,
        carId: null,
        position: null,
        mountedOdometerKm: null,
        kmTraveled: 3500,
      });
      expect(events.save).toHaveBeenCalledWith(
        expect.objectContaining({ carId: 'c1', position: 'DI' }),
      );
    });

    it('desmontar con un kilometraje menor que el del montaje es 400', async () => {
      dar(
        neumatico({
          status: TireStatus.MOUNTED,
          carId: 'c1',
          position: 'DI',
          mountedOdometerKm: 1000,
        }),
      );
      await expect(
        mover({ type: TireEventType.UNMOUNT, odometerKm: 900 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rotar cambia la posición y reinicia el montaje sumando lo recorrido', async () => {
      dar(
        neumatico({
          status: TireStatus.MOUNTED,
          carId: 'c1',
          position: 'DI',
          mountedOdometerKm: 1000,
        }),
      );
      await mover({
        type: TireEventType.ROTATE,
        odometerKm: 3000,
        position: 'TD',
      });
      expect(current).toMatchObject({
        position: 'TD',
        kmTraveled: 2000,
        mountedOdometerKm: 3000,
      });
    });

    it('rotar a la posición actual, sin posición, o a otro vehículo no es válido', async () => {
      dar(
        neumatico({
          status: TireStatus.MOUNTED,
          carId: 'c1',
          position: 'DI',
          mountedOdometerKm: 0,
        }),
      );
      await expect(
        mover({ type: TireEventType.ROTATE, odometerKm: 1, position: 'DI' }),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        mover({ type: TireEventType.ROTATE, odometerKm: 1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        mover({
          type: TireEventType.ROTATE,
          odometerKm: 1,
          position: 'TD',
          carId: 'otro',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('recapar suma el contador sin cambiar el estado', async () => {
      dar(neumatico());
      await mover({ type: TireEventType.RETREAD, odometerKm: 10 });
      expect(current).toMatchObject({
        status: TireStatus.IN_STOCK,
        retreadCount: 1,
      });
    });

    it('la baja es definitiva: un dado de baja no admite nada más', async () => {
      dar(neumatico({ status: TireStatus.RETIRED }));
      for (const type of [
        TireEventType.MOUNT,
        TireEventType.UNMOUNT,
        TireEventType.RETREAD,
        TireEventType.RETIRE,
      ]) {
        await expect(
          mover({ type, odometerKm: 1, carId: 'c1', position: 'DI' }),
        ).rejects.toBeInstanceOf(ConflictException);
      }
    });

    it('dar de baja uno montado cierra el montaje', async () => {
      dar(
        neumatico({
          status: TireStatus.MOUNTED,
          carId: 'c1',
          position: 'DI',
          mountedOdometerKm: 100,
        }),
      );
      await mover({ type: TireEventType.RETIRE, odometerKm: 600 });
      expect(current).toMatchObject({
        status: TireStatus.RETIRED,
        carId: null,
        kmTraveled: 500,
      });
    });

    it('un neumático de otra distribuidora es 404', async () => {
      tires.findOne.mockResolvedValue(null);
      await expect(
        mover({ type: TireEventType.RETIRE, odometerKm: 1 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
