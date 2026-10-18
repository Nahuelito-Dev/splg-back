import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { CarService } from '../car/car.service';
import { Car } from '../car/entities/car.entity';
import { FleetCostSourceService } from '../fleet/fleet-cost-source.service';
import { FleetCostService } from './fleet-cost.service';
import { FuelLoad } from './entities/fuel-load.entity';
import { TrafficFine } from './entities/traffic-fine.entity';
import { VehicleAccident } from './entities/vehicle-accident.entity';

describe('FleetCostService', () => {
  let service: FleetCostService;
  let cars: { findOne: jest.Mock; findAll: jest.Mock };
  let fleet: {
    mantenimiento: jest.Mock;
    seguros: jest.Mock;
    kmDeUso: jest.Mock;
  };
  let cargas: FuelLoad[];

  const auto = (carId: string) =>
    ({
      carId,
      carPatent: carId.toUpperCase(),
      carBrand: 'Fiat',
      carModel: 'X',
    }) as Car;
  const carga = (carId: string, monto: number, odometerKm: number) =>
    ({
      carId,
      totalAmount: monto,
      odometerKm,
      loadedAt: new Date('2026-10-10T12:00:00.000Z'),
    }) as FuelLoad;
  const repoCon = <T>(filas: () => T[]) => ({
    createQueryBuilder: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn(() => Promise.resolve(filas())),
    })),
  });

  beforeEach(() => {
    cargas = [];
    cars = {
      findOne: jest.fn(),
      findAll: jest.fn().mockResolvedValue([auto('a'), auto('b'), auto('c')]),
    };
    fleet = {
      mantenimiento: jest.fn().mockResolvedValue([]),
      seguros: jest.fn().mockResolvedValue([]),
      kmDeUso: jest.fn().mockResolvedValue([]),
    };
    service = new FleetCostService(
      repoCon(() => cargas) as unknown as Repository<FuelLoad>,
      repoCon(() => []) as unknown as Repository<TrafficFine>,
      repoCon(() => []) as unknown as Repository<VehicleAccident>,
      cars as unknown as CarService,
      fleet as unknown as FleetCostSourceService,
    );
  });

  describe('tablero (CU-204)', () => {
    it('ordena de mayor a menor costo por km y deja al final al que no tiene km', async () => {
      cargas = [
        carga('a', 10000, 1000),
        carga('a', 10000, 1500), // 20000 / 500 = 40 $/km
        carga('b', 80000, 1000),
        carga('b', 80000, 1500), // 160000 / 500 = 320 $/km
      ];
      fleet.mantenimiento.mockResolvedValue([
        {
          carId: 'c',
          performedAt: new Date('2026-10-12T12:00:00.000Z'),
          cost: 999999,
        },
      ]);
      const filas = await service.tablero('d1', '2026-10-01', '2026-10-31');
      expect(filas.map((f) => [f.carId, f.costPerKm])).toEqual([
        ['b', 320],
        ['a', 40],
        ['c', null],
      ]);
      expect(filas[2]).toMatchObject({
        total: 999999,
        km: 0,
        kmSource: 'none',
      });
    });

    it('con los km del registro de uso calcula el costo por km de ese vehículo', async () => {
      cargas = [carga('a', 10000, 1000)];
      fleet.kmDeUso.mockResolvedValue([{ carId: 'a', km: 100 }]);
      const filas = await service.tablero('d1', '2026-10-01', '2026-10-31');
      expect(filas[0]).toMatchObject({
        carId: 'a',
        costPerKm: 100,
        kmSource: 'usage_log',
      });
    });

    it('una flota vacía devuelve la lista vacía', async () => {
      cars.findAll.mockResolvedValue([]);
      expect(await service.tablero('d1', '2026-10-01', '2026-10-31')).toEqual(
        [],
      );
    });

    it('un rango invertido es 400 y no consulta nada', async () => {
      await expect(
        service.tablero('d1', '2026-10-31', '2026-10-01'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(cars.findAll).not.toHaveBeenCalled();
    });
  });

  describe('costoDelVehiculo (CU-203)', () => {
    it('un vehículo de otra distribuidora es 404', async () => {
      cars.findOne.mockRejectedValue(new NotFoundException());
      await expect(
        service.costoDelVehiculo('a', 'd1', '2026-10-01', '2026-10-31'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('trae el rango y la evolución mensual', async () => {
      cars.findOne.mockResolvedValue(auto('a'));
      cargas = [carga('a', 10000, 1000)];
      const dto = await service.costoDelVehiculo(
        'a',
        'd1',
        '2026-09-01',
        '2026-10-31',
      );
      expect(dto).toMatchObject({
        carId: 'a',
        from: '2026-09-01',
        to: '2026-10-31',
        fuel: 10000,
      });
      expect(dto.monthly.map((m) => m.month)).toEqual(['2026-09', '2026-10']);
    });
  });
});
