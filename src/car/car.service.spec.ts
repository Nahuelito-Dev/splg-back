import { ConflictException, NotFoundException } from '@nestjs/common';
import { EntityManager, Repository } from 'typeorm';
import { CarService } from './car.service';
import { Car, FleetStatus } from './entities/car.entity';
import { EVENTO_VEHICULO_DADO_DE_BAJA } from './events/vehiculo-dado-de-baja.event';
import { DeliveryService } from '../delivery/delivery.service';
import { VehicleAssignmentService } from './vehicle-assignment.service';

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
    manager: { transaction: jest.Mock };
  };
  let bloqueo: {
    setLock: jest.Mock;
    getOne: jest.Mock;
    andWhere: jest.Mock;
  };
  let txManager: { getRepository: jest.Mock; softRemove: jest.Mock };
  let txRepo: { preload: jest.Mock; save: jest.Mock };
  let deliveries: { findDistributorIdByUserId: jest.Mock };
  let vehicleAssignments: { assertVehiculoLibre: jest.Mock };

  const dto = { user_id: 'u1', car_patent: 'AB123CD' };

  beforeEach(() => {
    cars = {
      findOne: jest.fn(),
      create: jest.fn((c: Partial<Car>) => c),
      save: jest.fn((c: Car) => Promise.resolve(c)),
      softRemove: jest.fn(),
      manager: {
        transaction: jest.fn((fn: (m: unknown) => unknown) => fn(txManager)),
      },
    };
    bloqueo = {
      setLock: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
      andWhere: jest.fn().mockReturnThis(),
    };
    txRepo = {
      preload: jest.fn((c: Partial<Car>) => Promise.resolve(c)),
      save: jest.fn((c: Car) => Promise.resolve(c)),
    };
    txManager = {
      getRepository: jest.fn(() => ({
        ...txRepo,
        createQueryBuilder: () => ({
          setLock: bloqueo.setLock,
          where: jest.fn().mockReturnThis(),
          andWhere: bloqueo.andWhere,
          getOne: bloqueo.getOne,
        }),
      })),
      softRemove: jest.fn(),
    };
    deliveries = {
      findDistributorIdByUserId: jest.fn().mockResolvedValue('d1'),
    };
    vehicleAssignments = {
      assertVehiculoLibre: jest.fn().mockResolvedValue(undefined),
    };
    service = new CarService(
      cars as unknown as Repository<Car>,
      deliveries as unknown as DeliveryService,
      vehicleAssignments as unknown as VehicleAssignmentService,
    );
  });

  it('se crea en la distribuidora del admin', async () => {
    cars.findOne.mockResolvedValue(null);
    const c = await service.create(dto, 'd1');
    expect(c).toMatchObject({ userId: 'u1', distributorId: 'd1' });
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
    cars.findOne.mockResolvedValue({ carId: 'c1', userId: 'u1' });
    deliveries.findDistributorIdByUserId.mockResolvedValue('d2');
    await expect(
      service.update('c1', { user_id: 'u2' }, 'd1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('al editar, la patente nueva no puede ser la de otro auto', async () => {
    cars.findOne
      .mockResolvedValueOnce({ carId: 'c1', carPatent: 'AA111AA' })
      .mockResolvedValueOnce({ carId: 'c2', carPatent: 'BB222BB' });
    await expect(
      service.update('c1', { car_patent: 'BB222BB' }, 'd1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('la patente no se repite', async () => {
    cars.findOne.mockResolvedValue({ carId: 'otro' });
    await expect(service.create(dto, 'd1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('un admin no ve vehículos de otra distribuidora', async () => {
    cars.findOne.mockResolvedValue(null);
    await expect(service.findOne('c1', 'd2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(cars.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { carId: 'c1', distributorId: 'd2' },
      }),
    );
  });

  describe('baja', () => {
    beforeEach(() => {
      cars.findOne.mockResolvedValue({ carId: 'c1' });
      bloqueo.getOne.mockResolvedValue({ carId: 'c1' });
    });

    it('responde con el id borrado', async () => {
      await expect(service.remove('c1', 'd1')).resolves.toEqual({
        message: 'Car deleted successfully',
        carId: 'c1',
      });
      expect(txManager.softRemove).toHaveBeenCalledWith({ carId: 'c1' });
    });

    it('avisa la baja con el evento, ya confirmada, para que otros módulos cierren lo suyo', async () => {
      const emit = jest.fn();
      Object.assign(service, { eventos: { emit } });
      await service.remove('c1', 'd1');
      expect(emit).toHaveBeenCalledWith(
        EVENTO_VEHICULO_DADO_DE_BAJA,
        expect.objectContaining({ carId: 'c1', distributorId: 'd1' }),
      );
    });

    it('si la baja falla no emite el evento', async () => {
      const emit = jest.fn();
      Object.assign(service, { eventos: { emit } });
      cars.findOne.mockResolvedValue(null);
      await expect(service.remove('c1', 'd1')).rejects.toBeDefined();
      expect(emit).not.toHaveBeenCalled();
    });

    it('verifica que está libre y lo da de baja en la MISMA transacción, con la fila bloqueada', async () => {
      await service.remove('c1', 'd1');
      expect(cars.manager.transaction).toHaveBeenCalledTimes(1);
      expect(bloqueo.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(bloqueo.andWhere).toHaveBeenCalledWith(
        'car.distributorId = :distributorId',
        { distributorId: 'd1' },
      );
      expect(vehicleAssignments.assertVehiculoLibre).toHaveBeenCalledWith(
        'c1',
        txManager,
      );
    });

    it('no se puede dar de baja un vehículo en uso (409)', async () => {
      vehicleAssignments.assertVehiculoLibre.mockRejectedValue(
        new ConflictException('El vehículo está en uso: liberalo primero'),
      );
      await expect(service.remove('c1', 'd1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(txManager.softRemove).not.toHaveBeenCalled();
    });

    it('si el vehículo desapareció mientras esperaba el lock (otra baja ganó) es 404', async () => {
      bloqueo.getOne.mockResolvedValue(null);
      await expect(service.remove('c1', 'd1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(txManager.softRemove).not.toHaveBeenCalled();
    });
  });

  describe('edición de un vehículo en uso', () => {
    beforeEach(() => {
      cars.findOne.mockResolvedValue({
        carId: 'c1',
        userId: 'u1',
        carPatent: 'AB123CD',
        typeCar: 'Auto',
      });
      bloqueo.getOne.mockResolvedValue({ carId: 'c1' });
      vehicleAssignments.assertVehiculoLibre.mockRejectedValue(
        new ConflictException('El vehículo está en uso: liberalo primero'),
      );
    });

    it('cambiar la patente de un vehículo en uso es 409 y no guarda', async () => {
      await expect(
        service.update('c1', { car_patent: 'ZZ999ZZ' }, 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(txRepo.save).not.toHaveBeenCalled();
    });

    it('borrar la patente (null) de un vehículo en uso es 409 y no guarda', async () => {
      await expect(
        service.update('c1', { car_patent: null }, 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(txRepo.save).not.toHaveBeenCalled();
    });

    it('cambiar el tipo de un vehículo en uso es 409 y no guarda', async () => {
      await expect(
        service.update('c1', { type_car: 'Moto' }, 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(txRepo.save).not.toHaveBeenCalled();
    });

    it('verifica con la fila bloqueada, en la misma transacción que guarda', async () => {
      vehicleAssignments.assertVehiculoLibre.mockResolvedValue(undefined);
      await service.update('c1', { type_car: 'Moto' }, 'd1');
      expect(bloqueo.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(vehicleAssignments.assertVehiculoLibre).toHaveBeenCalledWith(
        'c1',
        txManager,
      );
      expect(txRepo.save).toHaveBeenCalledTimes(1);
    });

    it('si el vehículo desapareció mientras esperaba el lock es 404', async () => {
      bloqueo.getOne.mockResolvedValue(null);
      await expect(
        service.update('c1', { type_car: 'Moto' }, 'd1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('los demás campos se editan aunque esté en uso, sin lock ni verificación', async () => {
      (cars as unknown as { preload: jest.Mock }).preload = jest.fn(
        (c: Partial<Car>) => Promise.resolve(c),
      );
      await service.update('c1', { car_color: 'Rojo' }, 'd1');
      expect(vehicleAssignments.assertVehiculoLibre).not.toHaveBeenCalled();
      expect(cars.manager.transaction).not.toHaveBeenCalled();
      expect(cars.save).toHaveBeenCalledTimes(1);
    });

    it('mandar la misma patente y el mismo tipo no cuenta como cambio', async () => {
      (cars as unknown as { preload: jest.Mock }).preload = jest.fn(
        (c: Partial<Car>) => Promise.resolve(c),
      );
      await service.update(
        'c1',
        { car_patent: 'ab 123 cd', type_car: 'Auto' },
        'd1',
      );
      expect(vehicleAssignments.assertVehiculoLibre).not.toHaveBeenCalled();
    });
  });

  describe('patente normalizada', () => {
    it('al crear se guarda en mayúsculas y sin espacios ni guiones', async () => {
      cars.findOne.mockResolvedValue(null);
      await service.create({ user_id: 'u1', car_patent: 'ab 123-cd' }, 'd1');
      expect(cars.create).toHaveBeenCalledWith(
        expect.objectContaining({ carPatent: 'AB123CD' }),
      );
    });

    it('al crear, busca el duplicado con la patente normalizada', async () => {
      cars.findOne.mockResolvedValue({ carId: 'otro' });
      await expect(
        service.create({ user_id: 'u1', car_patent: 'ab-123 cd' }, 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
      // El duplicado se busca dentro de la distribuidora (no en todo el sistema).
      expect(cars.findOne).toHaveBeenCalledWith({
        where: { carPatent: 'AB123CD', distributorId: 'd1' },
      });
    });

    it('al editar, guarda la patente normalizada y no la considera cambio si es la misma', async () => {
      cars.findOne.mockResolvedValue({ carId: 'c1', carPatent: 'AB123CD' });
      (cars as unknown as { preload: jest.Mock }).preload = jest.fn(
        (c: Partial<Car>) => Promise.resolve(c),
      );
      await service.update('c1', { car_patent: 'ab 123 cd' }, 'd1');
      // Una sola búsqueda (la del `findOne` del tenant): no buscó duplicados.
      expect(cars.findOne).toHaveBeenCalledTimes(1);
      expect(
        (cars as unknown as { preload: jest.Mock }).preload,
      ).toHaveBeenCalledWith(expect.objectContaining({ carPatent: 'AB123CD' }));
    });

    it('al editar, car_patent null vuelve a guardar null', async () => {
      cars.findOne.mockResolvedValue({ carId: 'c1', carPatent: 'AB123CD' });
      bloqueo.getOne.mockResolvedValue({ carId: 'c1' });
      await service.update('c1', { car_patent: null }, 'd1');
      expect(txRepo.preload).toHaveBeenCalledWith(
        expect.objectContaining({ carPatent: null }),
      );
    });

    it('al editar, una patente vacía no se saltea el chequeo de duplicado', async () => {
      cars.findOne
        .mockResolvedValueOnce({ carId: 'c1', carPatent: 'AB123CD' })
        .mockResolvedValueOnce({ carId: 'c2', carPatent: '' });
      await expect(
        service.update('c1', { car_patent: '' }, 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('findByPatent busca con la patente normalizada', async () => {
      cars.findOne.mockResolvedValue(null);
      await service.findByPatent('ab 123-cd', 'd1');
      expect(cars.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { carPatent: 'AB123CD', distributorId: 'd1' },
        }),
      );
    });
  });

  it('un vehículo inexistente es 404 con el mensaje en castellano', async () => {
    cars.findOne.mockResolvedValue(null);
    await expect(service.findOne('c9', 'd1')).rejects.toThrow(
      'Vehículo c9 no encontrado',
    );
  });

  describe('kilometraje (punto único de escritura)', () => {
    let set: jest.Mock;
    let where: jest.Mock;
    let manager: { createQueryBuilder: jest.Mock };

    beforeEach(() => {
      set = jest.fn().mockReturnThis();
      where = jest.fn().mockReturnThis();
      const qb = {
        update: jest.fn().mockReturnThis(),
        set,
        where,
        setParameter: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(undefined),
      };
      manager = { createQueryBuilder: jest.fn(() => qb) };
    });

    it('actualizarOdometro sólo sube: usa el mayor entre el vigente y el nuevo', async () => {
      await service.actualizarOdometro(
        manager as unknown as EntityManager,
        'c1',
        1500,
      );
      const [[valores]] = set.mock.calls as Array<
        [{ odometerKm: () => string }]
      >;
      const { odometerKm } = valores;
      expect(odometerKm()).toContain('GREATEST(COALESCE("odometer_km", 0)');
    });

    it('bajarOdometro sin carga vigente que lo reemplace no toca nada', async () => {
      await service.bajarOdometro(
        manager as unknown as EntityManager,
        'c1',
        1500,
        null,
      );
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('bajarOdometro sólo baja si el vigente es el de la carga que deja de valer', async () => {
      await service.bajarOdometro(
        manager as unknown as EntityManager,
        'c1',
        1500,
        1000,
      );
      expect(set).toHaveBeenCalledWith({ odometerKm: 1000 });
      expect(where).toHaveBeenCalledWith(
        'car_id = :carId AND odometer_km = :km',
        { carId: 'c1', km: 1500 },
      );
    });
  });

  describe('cambiarEstadoDeFlota', () => {
    const conAuto = (auto: Partial<Car> | null) => {
      bloqueo.getOne.mockResolvedValue(auto);
      return txManager as unknown as EntityManager;
    };

    it('bloquea la fila y cambia el estado', async () => {
      const manager = conAuto({
        carId: 'c1',
        fleetStatus: FleetStatus.GROUNDED,
      });
      const car = await service.cambiarEstadoDeFlota(
        manager,
        'c1',
        'd1',
        FleetStatus.ACTIVE,
        FleetStatus.GROUNDED,
      );
      expect(car.fleetStatus).toBe(FleetStatus.ACTIVE);
      expect(bloqueo.setLock).toHaveBeenCalledWith('pessimistic_write');
    });

    it('un vehículo de otra distribuidora es 404', async () => {
      const manager = conAuto(null);
      await expect(
        service.cambiarEstadoDeFlota(manager, 'c1', 'd1', FleetStatus.ACTIVE),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('si ya no está en el estado esperado es 409 (carrera con otra request)', async () => {
      const manager = conAuto({
        carId: 'c1',
        fleetStatus: FleetStatus.ACTIVE,
      });
      await expect(
        service.cambiarEstadoDeFlota(
          manager,
          'c1',
          'd1',
          FleetStatus.ACTIVE,
          FleetStatus.GROUNDED,
        ),
      ).rejects.toThrow('El vehículo no está fuera de servicio');
    });
  });
});
