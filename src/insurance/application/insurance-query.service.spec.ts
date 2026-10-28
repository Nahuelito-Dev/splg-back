import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { CarService } from '../../car/car.service';
import { InsuranceInstallment } from '../entities/insurance-installment.entity';
import { InsurancePolicy } from '../entities/insurance-policy.entity';
import { InsuranceQueryService } from './insurance-query.service';

describe('InsuranceQueryService', () => {
  let service: InsuranceQueryService;
  let policies: { find: jest.Mock; findOne: jest.Mock };
  let cars: { findOne: jest.Mock };
  let filtros: Array<[string, unknown]>;
  let ordenes: string[];
  let conBajas: number;

  const poliza = (
    id: string,
    validFrom: string,
    validTo: string,
    cancelledAt: Date | null = null,
  ) => ({ policyId: id, validFrom, validTo, cancelledAt }) as InsurancePolicy;

  beforeEach(() => {
    filtros = [];
    ordenes = [];
    conBajas = 0;
    policies = { find: jest.fn(), findOne: jest.fn() };
    cars = { findOne: jest.fn().mockResolvedValue({ carId: 'c1' }) };
    const b: Record<string, jest.Mock> = {};
    b.withDeleted = jest.fn(() => {
      conBajas += 1;
      return b;
    });
    for (const metodo of [
      'innerJoinAndSelect',
      'leftJoinAndSelect',
      'addOrderBy',
      'limit',
      'offset',
    ]) {
      b[metodo] = jest.fn(() => b);
    }
    for (const metodo of ['where', 'andWhere']) {
      b[metodo] = jest.fn((condicion: string, parametros: unknown) => {
        filtros.push([condicion, parametros]);
        return b;
      });
    }
    b.orderBy = jest.fn((columna: string) => {
      ordenes.push(columna);
      return b;
    });
    b.getManyAndCount = jest.fn(() =>
      Promise.resolve([[{ installmentId: 'q1' }], 1]),
    );
    service = new InsuranceQueryService(
      policies as unknown as Repository<InsurancePolicy>,
      {
        createQueryBuilder: () => b,
      } as unknown as Repository<InsuranceInstallment>,
      cars as unknown as CarService,
    );
    jest.useFakeTimers().setSystemTime(new Date('2026-11-10T15:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('ofCar', () => {
    it('la que cubre hoy es la vigente y las demás, el historial', async () => {
      const vencida = poliza('vieja', '2025-12-22', '2026-06-22');
      const activa = poliza('activa', '2026-06-22', '2026-12-22');
      const futura = poliza('futura', '2026-12-22', '2027-06-22');
      const cancelada = poliza(
        'cancelada',
        '2026-07-01',
        '2027-01-01',
        new Date(),
      );
      policies.find.mockResolvedValue([futura, cancelada, activa, vencida]);

      const r = await service.ofCar('c1', 'd1');

      expect(r.current).toBe(activa);
      expect(r.history).toEqual([futura, cancelada, vencida]);
    });

    it('sin una que cubra hoy, muestra la próxima que empieza', async () => {
      const vencida = poliza('vieja', '2025-12-22', '2026-06-22');
      const lejana = poliza('lejana', '2027-06-22', '2027-12-22');
      const proxima = poliza('proxima', '2026-12-22', '2027-06-22');
      policies.find.mockResolvedValue([lejana, proxima, vencida]);

      const r = await service.ofCar('c1', 'd1');

      expect(r.current).toBe(proxima);
      expect(r.history).toEqual([lejana, vencida]);
    });

    it('una cancelada o vencida sola no es la vigente', async () => {
      policies.find.mockResolvedValue([
        poliza('cancelada', '2026-07-01', '2027-01-01', new Date()),
        poliza('vieja', '2025-12-22', '2026-06-22'),
      ]);
      const r = await service.ofCar('c1', 'd1');
      expect(r.current).toBeNull();
      expect(r.history).toHaveLength(2);
    });

    it('un vehículo de otra distribuidora es 404 y no consulta pólizas', async () => {
      cars.findOne.mockRejectedValue(new NotFoundException());
      await expect(service.ofCar('c1', 'd2')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(cars.findOne).toHaveBeenCalledWith('c1', 'd2');
      expect(policies.find).not.toHaveBeenCalled();
    });

    it('trae las pólizas del vehículo en la distribuidora', async () => {
      policies.find.mockResolvedValue([]);
      await service.ofCar('c1', 'd1');
      expect(policies.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { carId: 'c1', distributorId: 'd1' },
        }),
      );
    });
  });

  describe('findPolicy', () => {
    it('una póliza de otra distribuidora es 404', async () => {
      policies.findOne.mockResolvedValue(null);
      await expect(service.findPolicy('p1', 'd2')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(policies.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { policyId: 'p1', distributorId: 'd2' },
        }),
      );
    });
  });

  describe('findInstallments', () => {
    it('acota a la distribuidora y aplica los filtros', async () => {
      const r = await service.findInstallments('d1', {
        status: 'pending',
        dueFrom: '2026-11-01',
        dueTo: '2026-11-30',
        carId: 'c1',
        limit: 10,
        offset: 0,
      } as never);

      expect(r.total).toBe(1);
      expect(filtros).toEqual([
        ['c.distributor_id = :distributorId', { distributorId: 'd1' }],
        ['c.status = :status', { status: 'pending' }],
        ['c.due_date >= :dueFrom', { dueFrom: '2026-11-01' }],
        ['c.due_date <= :dueTo', { dueTo: '2026-11-30' }],
        ['p.car_id = :carId', { carId: 'c1' }],
      ]);
      expect(ordenes).toEqual(['c.due_date']);
      expect(conBajas).toBe(1); // una aseguradora dada de baja sigue figurando
    });

    it('sin filtros sólo acota a la distribuidora', async () => {
      await service.findInstallments('d1', {} as never);
      expect(filtros).toEqual([
        ['c.distributor_id = :distributorId', { distributorId: 'd1' }],
      ]);
    });
  });
});
