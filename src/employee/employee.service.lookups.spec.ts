import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { EmployeeService } from './employee.service';
import { Employee, EmployeeStatus } from './entities/employee.entity';
import { JobPositionCategory } from './entities/job-position.entity';
import { JobPositionService } from './job-position.service';
import { EmployeeRulesRegistry } from './employee-rules.registry';
import { DocumentSequenceService } from '../document-sequence/document-sequence.service';
import { DeliveryService } from '../delivery/delivery.service';
import { UsersService } from '../users/users.service';
import { S3CleanupService } from '../s3/s3-cleanup.service';

/** Las consultas de apoyo que el resto de los módulos de personal le hace al legajo. */
describe('EmployeeService (consultas de apoyo)', () => {
  let service: EmployeeService;
  let repo: {
    findOne: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };

  const legajo = (over: Partial<Employee> = {}) =>
    ({
      employeeId: 'e1',
      distributorId: 'd1',
      userId: 'u1',
      firstName: 'Ana',
      lastName: 'Pérez',
      status: EmployeeStatus.ACTIVE,
      position: { category: JobPositionCategory.DRIVER },
      ...over,
    }) as Employee;

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(),
    };
    service = new EmployeeService(
      repo as unknown as Repository<Employee>,
      {} as DataSource,
      {} as JobPositionService,
      {} as DocumentSequenceService,
      {} as DeliveryService,
      {} as UsersService,
      {} as EmployeeRulesRegistry,
      {} as S3CleanupService,
    );
  });

  describe('findActivo', () => {
    it('devuelve el legajo activo de la distribuidora', async () => {
      repo.findOne.mockResolvedValue(legajo());
      await expect(service.findActivo('e1', 'd1')).resolves.toMatchObject({
        employeeId: 'e1',
      });
      expect(repo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { employeeId: 'e1', distributorId: 'd1' },
        }),
      );
    });

    it('uno de otra distribuidora es 404 y uno egresado es 409', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findActivo('e1', 'd2')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      repo.findOne.mockResolvedValue(
        legajo({ status: EmployeeStatus.TERMINATED }),
      );
      await expect(service.findActivo('e1', 'd1')).rejects.toThrow(
        /Ana Pérez está egresado/,
      );
    });

    it('con manager toma el lock del legajo antes de leerlo', async () => {
      const bloqueado = legajo();
      const findOne = jest
        .fn()
        .mockResolvedValueOnce(bloqueado) // bloquear()
        .mockResolvedValueOnce(bloqueado); // con el puesto
      const manager = {
        getRepository: () => ({
          findOne,
          findOneOrFail: findOne,
        }),
      } as unknown as EntityManager;

      const res = await service.findActivo('e1', 'd1', manager);

      expect(res.employeeId).toBe('e1');
      expect(findOne).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
    });

    it('con manager, un legajo egresado también es 409', async () => {
      const egresado = legajo({ status: EmployeeStatus.TERMINATED });
      const findOne = jest.fn().mockResolvedValue(egresado);
      const manager = {
        getRepository: () => ({ findOne, findOneOrFail: findOne }),
      } as unknown as EntityManager;
      await expect(
        service.findActivo('e1', 'd1', manager),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('búsquedas en lote', () => {
    it('findByUserIds sin cuentas no consulta', async () => {
      await expect(service.findByUserIds([])).resolves.toEqual([]);
      expect(repo.find).not.toHaveBeenCalled();
    });

    it('findByUserIds acota por distribuidora cuando viene', async () => {
      repo.find.mockResolvedValue([legajo()]);
      await service.findByUserIds(['u1'], 'd1');
      const [[opciones]] = repo.find.mock.calls as [
        [{ where: { distributorId?: string } }],
      ];
      expect(opciones.where.distributorId).toBe('d1');

      await service.findByUserIds(['u1']);
      const [, [sinTenant]] = repo.find.mock.calls as [
        unknown,
        [{ where: Record<string, unknown> }],
      ];
      expect(sinTenant.where).not.toHaveProperty('distributorId');
    });

    it('findByUserId devuelve el legajo o null', async () => {
      repo.find.mockResolvedValueOnce([legajo()]);
      await expect(service.findByUserId('u1')).resolves.toMatchObject({
        employeeId: 'e1',
      });
      repo.find.mockResolvedValueOnce([]);
      await expect(service.findByUserId('u9')).resolves.toBeNull();
    });

    it('findActivos filtra por estado activo y, si viene, por categoría', async () => {
      await service.findActivos('d1', JobPositionCategory.DRIVER);
      await service.findActivos('d1');
      const [[conCategoria], [sinCategoria]] = repo.find.mock.calls as [
        [{ where: Record<string, unknown> }],
        [{ where: Record<string, unknown> }],
      ];
      expect(conCategoria.where).toMatchObject({
        distributorId: 'd1',
        status: EmployeeStatus.ACTIVE,
        position: { category: JobPositionCategory.DRIVER },
      });
      expect(sinCategoria.where).not.toHaveProperty('position');
    });

    it('findByIds sin ids no consulta; con ids, acota por distribuidora', async () => {
      await expect(service.findByIds([], 'd1')).resolves.toEqual([]);
      expect(repo.find).not.toHaveBeenCalled();
      await service.findByIds(['e1'], 'd1');
      expect(repo.find).toHaveBeenCalledTimes(1);
    });
  });

  describe('agregados', () => {
    function qbConFilas(filas: unknown[]) {
      const qb: Record<string, jest.Mock> = {};
      for (const m of [
        'innerJoin',
        'select',
        'addSelect',
        'where',
        'andWhere',
        'groupBy',
        'addGroupBy',
        'orderBy',
      ]) {
        qb[m] = jest.fn().mockReturnValue(qb);
      }
      qb.getRawMany = jest.fn().mockResolvedValue(filas);
      repo.createQueryBuilder.mockReturnValue(qb);
      return qb;
    }

    it('contarActivosPorPuesto convierte el conteo a número', async () => {
      qbConFilas([
        { positionId: 'p1', name: 'Chofer', category: 'driver', count: '6' },
      ]);
      await expect(service.contarActivosPorPuesto('d1')).resolves.toEqual([
        { positionId: 'p1', name: 'Chofer', category: 'driver', count: 6 },
      ]);
    });

    it('distribuidorasConChoferesActivos devuelve sólo los ids', async () => {
      qbConFilas([{ distributorId: 'd1' }, { distributorId: 'd2' }]);
      await expect(service.distribuidorasConChoferesActivos()).resolves.toEqual(
        ['d1', 'd2'],
      );
    });
  });
});
