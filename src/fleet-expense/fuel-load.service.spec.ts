import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { CarService } from '../car/car.service';
import { FuelType } from '../car/entities/car.entity';
import { FleetCostSourceService } from '../fleet/fleet-cost-source.service';
import { DriverContextService } from './driver-context.service';
import { FuelLoad, FuelPaymentMethod } from './entities/fuel-load.entity';
import { EVENTO_CARGA_ANOMALA } from './events/fleet-expense.events';
import { FuelLoadService } from './fuel-load.service';

describe('FuelLoadService', () => {
  let service: FuelLoadService;
  let repo: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    softRemove: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let anterior: { getOne: jest.Mock; getRawOne: jest.Mock };
  let cars: {
    findOne: jest.Mock;
    bloquear: jest.Mock;
    actualizarOdometro: jest.Mock;
    bajarOdometro: jest.Mock;
  };
  let driver: {
    legajoDelVehiculoEn: jest.Mock;
    legajoDe: jest.Mock;
    vehiculoEnUso: jest.Mock;
  };
  let eventos: { emit: jest.Mock };
  let fleet: { kmMaximoDeTareasHechas: jest.Mock };
  let guardadas: FuelLoad[];

  const dto = {
    carId: 'c1',
    liters: 40,
    unitPrice: 1000,
    totalAmount: 40000,
    odometerKm: 1000,
    paymentMethod: FuelPaymentMethod.CARD,
  };

  beforeEach(() => {
    guardadas = [];
    anterior = {
      getOne: jest.fn().mockResolvedValue(null),
      getRawOne: jest.fn().mockResolvedValue({ max: null }),
    };
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getOne: anterior.getOne,
      getRawOne: anterior.getRawOne,
    };
    repo = {
      create: jest.fn((f: Partial<FuelLoad>) => ({ ...f })),
      save: jest.fn((f: FuelLoad) => {
        guardadas.push({ ...f });
        return Promise.resolve({ ...f, fuelLoadId: f.fuelLoadId ?? 'f1' });
      }),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      softRemove: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => qb),
    };
    const manager = { getRepository: () => repo };
    const dataSource = {
      transaction: jest.fn((cb: (m: unknown) => unknown) => cb(manager)),
    };
    cars = {
      findOne: jest.fn().mockResolvedValue({ carId: 'c1' }),
      bloquear: jest.fn().mockResolvedValue({
        carId: 'c1',
        fuelType: FuelType.DIESEL,
        tankCapacityLiters: 60,
      }),
      actualizarOdometro: jest.fn().mockResolvedValue(undefined),
      bajarOdometro: jest.fn().mockResolvedValue(undefined),
    };
    driver = {
      legajoDelVehiculoEn: jest.fn().mockResolvedValue('e1'),
      legajoDe: jest.fn().mockResolvedValue('e2'),
      vehiculoEnUso: jest.fn().mockResolvedValue('c1'),
    };
    eventos = { emit: jest.fn() };
    fleet = { kmMaximoDeTareasHechas: jest.fn().mockResolvedValue(null) };
    service = new FuelLoadService(
      repo as unknown as Repository<FuelLoad>,
      dataSource as unknown as DataSource,
      cars as unknown as CarService,
      driver as unknown as DriverContextService,
      eventos as unknown as EventEmitter2,
      fleet as unknown as FleetCostSourceService,
    );
    // lo que `registrar` lee al final
    jest.spyOn(service, 'findOne').mockResolvedValue({} as FuelLoad);
  });

  describe('registrar', () => {
    it('toma el combustible del vehículo, deduce quién cargó y sube el kilometraje', async () => {
      await service.registrar(dto, 'd1', 'u1');
      expect(guardadas[0]).toMatchObject({
        fuelType: FuelType.DIESEL,
        employeeId: 'e1',
        isFullTank: true,
        anomaly: false,
        createdByUserId: 'u1',
      });
      expect(cars.actualizarOdometro).toHaveBeenCalledWith(
        expect.anything(),
        'c1',
        1000,
      );
      expect(eventos.emit).not.toHaveBeenCalled();
    });

    it('sin combustible en la carga ni en el vehículo es 400', async () => {
      cars.bloquear.mockResolvedValue({ carId: 'c1', fuelType: null });
      await expect(service.registrar(dto, 'd1', 'u1')).rejects.toThrow(
        /fuelType/,
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('un importe que no coincide con litros × precio es 400 con el campo', async () => {
      await expect(
        service.registrar({ ...dto, totalAmount: 50000 }, 'd1', 'u1'),
      ).rejects.toThrow(/totalAmount/);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('los litros que superan el tanque + 5 % son 400', async () => {
      await expect(
        service.registrar(
          { ...dto, liters: 64, totalAmount: 64000 },
          'd1',
          'u1',
        ),
      ).rejects.toThrow(/liters/);
    });

    it('sin capacidad cargada no se controla el tanque', async () => {
      cars.bloquear.mockResolvedValue({
        carId: 'c1',
        fuelType: FuelType.DIESEL,
        tankCapacityLiters: null,
      });
      await service.registrar(
        { ...dto, liters: 500, totalAmount: 500000 },
        'd1',
        'u1',
      );
      expect(repo.save).toHaveBeenCalled();
    });

    it('un kilometraje menor que el de la última carga es 400', async () => {
      anterior.getOne.mockResolvedValue({ odometerKm: 1200 });
      await expect(service.registrar(dto, 'd1', 'u1')).rejects.toThrow(
        'El kilometraje es menor que el de la última carga',
      );
    });

    it('con corrección y nota el administrador lo fuerza; sin nota no', async () => {
      anterior.getOne.mockResolvedValue({ odometerKm: 1200 });
      await expect(
        service.registrar({ ...dto, odometerCorrection: true }, 'd1', 'u1'),
      ).rejects.toThrow(/odometerCorrectionNote/);

      await service.registrar(
        {
          ...dto,
          odometerCorrection: true,
          odometerCorrectionNote: 'Cambio de tablero',
        },
        'd1',
        'u1',
      );
      expect(guardadas[0].odometerCorrectionNote).toBe('Cambio de tablero');
    });

    it('una carga futura es 400', async () => {
      await expect(
        service.registrar(
          { ...dto, loadedAt: '2999-01-01T00:00:00.000Z' },
          'd1',
          'u1',
        ),
      ).rejects.toThrow(/loadedAt/);
    });

    it('un vehículo de otra distribuidora corta antes de todo (404)', async () => {
      cars.findOne.mockRejectedValue(new NotFoundException());
      await expect(service.registrar(dto, 'd1', 'u1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(cars.bloquear).not.toHaveBeenCalled();
    });

    it('una carga con consumo anómalo se marca y publica el aviso', async () => {
      // siete llenas a 10 km/L y esta, a 7,4 km/L
      const historia = Array.from({ length: 7 }, (_, i) => ({
        fuelLoadId: `h${i}`,
        odometerKm: i * 400,
        liters: 40,
        totalAmount: 40000,
        isFullTank: true,
        loadedAt: new Date(Date.UTC(2026, 0, i + 1)),
      }));
      repo.find.mockImplementation(() =>
        Promise.resolve([
          ...historia,
          {
            fuelLoadId: 'f1',
            odometerKm: 7 * 400,
            liters: 54,
            totalAmount: 54000,
            isFullTank: true,
            loadedAt: new Date(Date.UTC(2026, 0, 20)),
          },
        ]),
      );
      await service.registrar(
        { ...dto, odometerKm: 7 * 400, liters: 54, totalAmount: 54000 },
        'd1',
        'u1',
      );
      expect(guardadas.at(-1)?.anomaly).toBe(true);
      expect(eventos.emit).toHaveBeenCalledWith(
        EVENTO_CARGA_ANOMALA,
        expect.objectContaining({ distributorId: 'd1', carId: 'c1' }),
      );
    });
  });

  describe('registrarPropia (chofer)', () => {
    const { carId: _omitido, ...propia } = dto;
    void _omitido;

    it('usa su vehículo en uso y su propio legajo', async () => {
      await service.registrarPropia(propia, 'd1', 'u1');
      expect(driver.vehiculoEnUso).toHaveBeenCalledWith('u1', 'd1');
      expect(guardadas[0]).toMatchObject({ carId: 'c1', employeeId: 'e2' });
    });

    it('sin vehículo en uso no registra nada', async () => {
      driver.vehiculoEnUso.mockRejectedValue(
        new NotFoundException('No tenés un vehículo en uso'),
      );
      await expect(service.registrarPropia(propia, 'd1', 'u1')).rejects.toThrow(
        'No tenés un vehículo en uso',
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('no puede forzar el kilometraje aunque el cuerpo lo traiga', async () => {
      anterior.getOne.mockResolvedValue({ odometerKm: 1200 });
      const trucho = {
        ...propia,
        odometerCorrection: true,
        odometerCorrectionNote: 'x',
      } as typeof propia;
      await expect(service.registrarPropia(trucho, 'd1', 'u1')).rejects.toThrow(
        'El kilometraje es menor',
      );
    });
  });

  describe('modificar y anular', () => {
    const vigente = (over: Partial<FuelLoad> = {}) =>
      ({
        fuelLoadId: 'f1',
        carId: 'c1',
        distributorId: 'd1',
        loadedAt: new Date('2026-10-01T12:00:00.000Z'),
        liters: 40,
        unitPrice: 1000,
        totalAmount: 40000,
        odometerKm: 1500,
        isFullTank: true,
        deletedAt: null,
        ...over,
      }) as FuelLoad;

    it('modificar una carga anulada es 409', async () => {
      repo.findOne.mockResolvedValue(vigente({ deletedAt: new Date() }));
      await expect(
        service.modificar('f1', { station: 'x' }, 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('modificar una carga de otra distribuidora es 404', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.modificar('f1', { station: 'x' }, 'd1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('modificar revalida el importe con los valores resultantes', async () => {
      repo.findOne.mockResolvedValue(vigente());
      await expect(
        service.modificar('f1', { liters: 20 }, 'd1'),
      ).rejects.toThrow(/totalAmount/);
    });

    it('modificar el kilometraje hacia abajo lo baja en el vehículo si lo había fijado esta carga', async () => {
      repo.findOne.mockResolvedValue(vigente());
      anterior.getRawOne.mockResolvedValue({ max: 1200 });
      await service.modificar('f1', { odometerKm: 1200 }, 'd1');
      expect(cars.bajarOdometro).toHaveBeenCalledWith(
        expect.anything(),
        'c1',
        1500,
        1200,
      );
    });

    it('modificar el kilometraje hacia arriba lo sube por el punto único', async () => {
      repo.findOne.mockResolvedValue(vigente());
      await service.modificar('f1', { odometerKm: 1800 }, 'd1');
      expect(cars.actualizarOdometro).toHaveBeenCalledWith(
        expect.anything(),
        'c1',
        1800,
      );
    });

    it('anular es una baja lógica y recalcula el kilometraje con la carga vigente que queda', async () => {
      repo.findOne.mockResolvedValue(vigente());
      anterior.getRawOne.mockResolvedValue({ max: 1000 });
      const res = await service.anular('f1', 'd1');
      expect(repo.softRemove).toHaveBeenCalled();
      expect(cars.bajarOdometro).toHaveBeenCalledWith(
        expect.anything(),
        'c1',
        1500,
        1000,
      );
      expect(res.message).toContain('anulada');
    });

    it('al anular, el kilometraje restante es el mayor entre las cargas vigentes y las tareas hechas', async () => {
      repo.findOne.mockResolvedValue(vigente());
      anterior.getRawOne.mockResolvedValue({ max: 1000 });
      fleet.kmMaximoDeTareasHechas.mockResolvedValue(1300);
      await service.anular('f1', 'd1');
      expect(cars.bajarOdometro).toHaveBeenCalledWith(
        expect.anything(),
        'c1',
        1500,
        1300,
      );
    });

    it('sin cargas vigentes, el kilometraje restante sale de las tareas hechas', async () => {
      repo.findOne.mockResolvedValue(vigente());
      anterior.getRawOne.mockResolvedValue({ max: null });
      fleet.kmMaximoDeTareasHechas.mockResolvedValue(900);
      await service.anular('f1', 'd1');
      expect(cars.bajarOdometro).toHaveBeenCalledWith(
        expect.anything(),
        'c1',
        1500,
        900,
      );
    });

    it('sin cargas ni tareas con kilometraje, el vehículo conserva el que tenía', async () => {
      repo.findOne.mockResolvedValue(vigente());
      anterior.getRawOne.mockResolvedValue({ max: null });
      await service.anular('f1', 'd1');
      expect(cars.bajarOdometro).toHaveBeenCalledWith(
        expect.anything(),
        'c1',
        1500,
        null,
      );
    });

    it('anular una ya anulada es 409', async () => {
      repo.findOne.mockResolvedValue(vigente({ deletedAt: new Date() }));
      await expect(service.anular('f1', 'd1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(repo.softRemove).not.toHaveBeenCalled();
    });
  });

  it('los errores de dato siguen siendo 400, no 500', async () => {
    await expect(
      service.registrar({ ...dto, totalAmount: 1 }, 'd1', 'u1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
