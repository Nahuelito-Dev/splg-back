import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { LeaveService } from './leave.service';
import { EmployeeLeave, LeaveType } from './entities/employee-leave.entity';
import { LeaveStatus } from './domain/leave-state';
import { EmployeeService } from '../employee/employee.service';
import { Employee } from '../employee/entities/employee.entity';
import { diaArgentino, sumarDias } from '../common/utils/dias-argentina';

/** Un query builder de mentira: cada método devuelve el mismo objeto y se registran las condiciones. */
function crearQb(resultados: {
  getOne?: unknown;
  getManyAndCount?: [unknown[], number];
  getMany?: unknown[];
  getRawMany?: unknown[];
  getRawOne?: unknown;
}) {
  const condiciones: Array<[string, unknown]> = [];
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'select',
    'innerJoinAndSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'skip',
    'take',
  ]) {
    qb[m] = jest.fn((...args: unknown[]) => {
      if (m === 'where' || m === 'andWhere') {
        condiciones.push([args[0] as string, args[1]]);
      }
      return qb;
    });
  }
  qb.getOne = jest.fn().mockResolvedValue(resultados.getOne ?? null);
  qb.getMany = jest.fn().mockResolvedValue(resultados.getMany ?? []);
  qb.getManyAndCount = jest
    .fn()
    .mockResolvedValue(resultados.getManyAndCount ?? [[], 0]);
  qb.getRawMany = jest.fn().mockResolvedValue(resultados.getRawMany ?? []);
  qb.getRawOne = jest.fn().mockResolvedValue(resultados.getRawOne);
  return { qb, condiciones };
}

describe('LeaveService', () => {
  let service: LeaveService;
  let guardadas: EmployeeLeave[];
  let repoDeLaTransaccion: {
    save: jest.Mock;
    create: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
    exists: jest.Mock;
  };
  let repoDelServicio: { createQueryBuilder: jest.Mock };
  let employees: {
    findActivo: jest.Mock;
    findOne: jest.Mock;
    bloquear: jest.Mock;
  };
  let superposicion: ReturnType<typeof crearQb>;

  const legajo = {
    employeeId: 'e1',
    firstName: 'Ana',
    lastName: 'Pérez',
    fileNumber: '0001',
    hireDate: '2024-03-01',
  } as Employee;

  const licencia = (over: Partial<EmployeeLeave> = {}): EmployeeLeave =>
    ({
      leaveId: 'l1',
      distributorId: 'd1',
      employeeId: 'e1',
      type: LeaveType.VACATION,
      startDate: '2099-12-01',
      endDate: '2099-12-14',
      days: 14,
      status: LeaveStatus.REQUESTED,
      reason: null,
      rejectionReason: null,
      requestedByUserId: 'admin-1',
      decidedByUserId: null,
      decidedAt: null,
      ...over,
    }) as EmployeeLeave;

  beforeEach(() => {
    guardadas = [];
    superposicion = crearQb({});
    repoDeLaTransaccion = {
      create: jest.fn((l: Partial<EmployeeLeave>) => l),
      save: jest.fn((l: EmployeeLeave) => {
        guardadas.push({ ...l });
        return Promise.resolve({ ...l, leaveId: l.leaveId ?? 'nueva' });
      }),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => superposicion.qb),
      exists: jest.fn(),
    };
    const manager = {
      getRepository: (entidad: unknown) =>
        entidad === Employee
          ? { findOneByOrFail: jest.fn().mockResolvedValue(legajo) }
          : repoDeLaTransaccion,
    } as unknown as EntityManager;
    const dataSource = {
      transaction: (fn: (m: EntityManager) => Promise<unknown>) => fn(manager),
    } as unknown as DataSource;
    repoDelServicio = { createQueryBuilder: jest.fn() };
    employees = {
      findActivo: jest.fn().mockResolvedValue(legajo),
      findOne: jest.fn().mockResolvedValue(legajo),
      bloquear: jest.fn().mockResolvedValue(legajo),
    };
    service = new LeaveService(
      repoDelServicio as unknown as Repository<EmployeeLeave>,
      dataSource,
      employees as unknown as EmployeeService,
    );
  });

  describe('create (CU-191)', () => {
    const cuerpo = {
      type: LeaveType.VACATION,
      startDate: '2026-12-01',
      endDate: '2026-12-14',
    };

    it('nace solicitada, con los días corridos y quién la cargó, bajo el lock del legajo', async () => {
      const creada = await service.create('e1', cuerpo, 'd1', 'admin-1');

      expect(employees.findActivo).toHaveBeenCalledWith(
        'e1',
        'd1',
        expect.anything(),
      );
      expect(guardadas[0]).toMatchObject({
        distributorId: 'd1',
        employeeId: 'e1',
        status: LeaveStatus.REQUESTED,
        days: 14,
        requestedByUserId: 'admin-1',
        decidedByUserId: null,
      });
      expect(creada.employee.fileNumber).toBe('0001');
    });

    it('un fin anterior al inicio es 400 y no toca la base', async () => {
      await expect(
        service.create(
          'e1',
          { ...cuerpo, startDate: '2026-12-10', endDate: '2026-12-01' },
          'd1',
          'admin-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(employees.findActivo).not.toHaveBeenCalled();
    });

    it('un período que pisa otra licencia solicitada o aprobada es 409 e indica cuál', async () => {
      superposicion = crearQb({
        getOne: licencia({
          leaveId: 'l9',
          startDate: '2026-12-10',
          endDate: '2026-12-20',
          status: LeaveStatus.APPROVED,
        }),
      });

      await expect(
        service.create('e1', cuerpo, 'd1', 'admin-1'),
      ).rejects.toThrow(
        /con otra licencia \(vacaciones, aprobada\) del 2026-12-10 al 2026-12-20/,
      );
      expect(guardadas).toEqual([]);
      // Sólo cuentan las vigentes: las rechazadas y canceladas liberan el período.
      const [, parametros] = superposicion.condiciones.find(([c]) =>
        c.includes('status IN'),
      ) as [string, { vigentes: string[] }];
      expect(parametros.vigentes).toEqual([
        LeaveStatus.REQUESTED,
        LeaveStatus.APPROVED,
      ]);
    });

    it('un empleado egresado (409) o de otra distribuidora (404) viene de EmployeeService', async () => {
      employees.findActivo.mockRejectedValue(new ConflictException());
      await expect(
        service.create('e1', cuerpo, 'd1', 'admin-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      employees.findActivo.mockRejectedValue(new NotFoundException());
      await expect(
        service.create('e1', cuerpo, 'd1', 'admin-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update (CU-316)', () => {
    it('modifica una solicitada, recalcula los días y no se cuenta a sí misma en la superposición', async () => {
      repoDeLaTransaccion.findOne.mockResolvedValue(licencia());

      const res = await service.update('l1', { endDate: '2099-12-20' }, 'd1');

      expect(res.days).toBe(20);
      expect(res.endDate).toBe('2099-12-20');
      expect(employees.bloquear).toHaveBeenCalledWith(
        expect.anything(),
        'e1',
        'd1',
      );
      const [, parametros] = superposicion.condiciones.find(([c]) =>
        c.includes('<> :excepto'),
      ) as [string, { excepto: string }];
      expect(parametros.excepto).toBe('l1');
    });

    it('una aprobada no se modifica (409)', async () => {
      repoDeLaTransaccion.findOne.mockResolvedValue(
        licencia({ status: LeaveStatus.APPROVED }),
      );
      await expect(
        service.update('l1', { reason: 'otra' }, 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(guardadas).toEqual([]);
    });

    it('un período invertido es 400 y uno que pisa otra licencia es 409', async () => {
      repoDeLaTransaccion.findOne.mockResolvedValue(licencia());
      await expect(
        service.update('l1', { startDate: '2099-12-30' }, 'd1'),
      ).rejects.toBeInstanceOf(BadRequestException);

      superposicion = crearQb({ getOne: licencia({ leaveId: 'l2' }) });
      await expect(
        service.update('l1', { endDate: '2099-12-31' }, 'd1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('una licencia de otra distribuidora es 404', async () => {
      repoDeLaTransaccion.findOne.mockResolvedValue(null);
      await expect(
        service.update('l1', { reason: 'x' }, 'd1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repoDeLaTransaccion.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { leaveId: 'l1', distributorId: 'd1' },
        }),
      );
    });
  });

  describe('approve / reject / cancel', () => {
    beforeEach(() => {
      repoDeLaTransaccion.findOne.mockResolvedValue(licencia());
    });

    it('aprobar asienta quién y cuándo', async () => {
      const res = await service.approve('l1', 'd1', 'admin-2');
      expect(res).toMatchObject({
        status: LeaveStatus.APPROVED,
        decidedByUserId: 'admin-2',
      });
      expect(res.decidedAt).toBeInstanceOf(Date);
    });

    it('aprobar una licencia que no está solicitada es 409', async () => {
      repoDeLaTransaccion.findOne.mockResolvedValue(
        licencia({ status: LeaveStatus.REJECTED }),
      );
      await expect(
        service.approve('l1', 'd1', 'admin-2'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rechazar guarda el motivo recortado, el autor y la fecha', async () => {
      const res = await service.reject(
        'l1',
        '  Sin cobertura ',
        'd1',
        'admin-2',
      );
      expect(res).toMatchObject({
        status: LeaveStatus.REJECTED,
        rejectionReason: 'Sin cobertura',
        decidedByUserId: 'admin-2',
      });
    });

    it('rechazar sin motivo es 400; con la licencia ya aprobada, 409', async () => {
      await expect(
        service.reject('l1', '   ', 'd1', 'admin-2'),
      ).rejects.toBeInstanceOf(BadRequestException);
      repoDeLaTransaccion.findOne.mockResolvedValue(
        licencia({ status: LeaveStatus.APPROVED }),
      );
      await expect(
        service.reject('l1', 'motivo', 'd1', 'admin-2'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('cancelar una aprobada que no terminó la libera', async () => {
      repoDeLaTransaccion.findOne.mockResolvedValue(
        licencia({ status: LeaveStatus.APPROVED }),
      );
      const res = await service.cancel('l1', 'd1', 'admin-2');
      expect(res.status).toBe(LeaveStatus.CANCELLED);
    });

    it('cancelar una que ya terminó, o ya cancelada, es 409', async () => {
      repoDeLaTransaccion.findOne.mockResolvedValue(
        licencia({
          status: LeaveStatus.APPROVED,
          startDate: sumarDias(diaArgentino(), -10),
          endDate: sumarDias(diaArgentino(), -1),
        }),
      );
      await expect(service.cancel('l1', 'd1', 'a')).rejects.toThrow(
        'La licencia ya terminó',
      );
      repoDeLaTransaccion.findOne.mockResolvedValue(
        licencia({ status: LeaveStatus.CANCELLED }),
      );
      await expect(service.cancel('l1', 'd1', 'a')).rejects.toThrow(
        'La licencia ya está cancelada',
      );
    });

    it('una licencia de otra distribuidora es 404 en las tres', async () => {
      repoDeLaTransaccion.findOne.mockResolvedValue(null);
      await expect(service.approve('x', 'd1', 'a')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.reject('x', 'm', 'd1', 'a')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.cancel('x', 'd1', 'a')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('findAll (CU-319)', () => {
    it('acota por distribuidora y aplica los filtros', async () => {
      const { qb, condiciones } = crearQb({
        getManyAndCount: [[licencia()], 1],
      });
      repoDelServicio.createQueryBuilder.mockReturnValue(qb);

      const res = await service.findAll(
        {
          status: LeaveStatus.REQUESTED,
          type: LeaveType.SICK,
          employeeId: 'e1',
          from: '2026-01-01',
          to: '2026-12-31',
          page: 2,
          limit: 5,
        },
        'd1',
      );

      expect(res.total).toBe(1);
      expect(condiciones.map(([c]) => c)).toEqual([
        'l.distributorId = :distributorId',
        'l.status = :status',
        'l.type = :type',
        'l.employeeId = :employeeId',
        'l.endDate >= :from',
        'l.startDate <= :to',
      ]);
      expect(condiciones[0][1]).toEqual({ distributorId: 'd1' });
      expect(qb.skip).toHaveBeenCalledWith(5);
      expect(qb.take).toHaveBeenCalledWith(5);
    });

    it('un período invertido es 400 e indica el filtro', async () => {
      await expect(
        service.findAll({ from: '2026-05-01', to: '2026-04-01' }, 'd1'),
      ).rejects.toThrow(/^to:/);
    });
  });

  describe('vacationBalance (CU-193)', () => {
    it('días por antigüedad menos los de vacaciones aprobadas que caen en el año', async () => {
      const { qb } = crearQb({
        getMany: [
          licencia({ startDate: '2026-03-02', endDate: '2026-03-15' }),
          licencia({ startDate: '2026-12-28', endDate: '2027-01-03' }),
        ],
      });
      repoDelServicio.createQueryBuilder.mockReturnValue(qb);

      const res = await service.vacationBalance('e1', 'd1', 2026);

      expect(res).toEqual({
        employeeId: 'e1',
        year: 2026,
        entitledDays: 14,
        takenDays: 18,
        balanceDays: -4,
      });
    });

    it('sin año usa el actual; un legajo de otra distribuidora es 404', async () => {
      const { qb } = crearQb({});
      repoDelServicio.createQueryBuilder.mockReturnValue(qb);
      const res = await service.vacationBalance('e1', 'd1');
      expect(res.year).toBe(Number(diaArgentino().slice(0, 4)));

      employees.findOne.mockRejectedValue(new NotFoundException());
      await expect(
        service.vacationBalance('e1', 'd2', 2026),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('consultas para el despacho y el tablero', () => {
    it('sin legajos no consulta nada', async () => {
      await expect(
        service.empleadosDeLicenciaEn([], '2026-10-17'),
      ).resolves.toEqual(new Set());
      expect(repoDelServicio.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('devuelve los legajos con una aprobada que cubre el día', async () => {
      const { qb, condiciones } = crearQb({
        getRawMany: [{ employeeId: 'e1' }],
      });
      repoDelServicio.createQueryBuilder.mockReturnValue(qb);

      const res = await service.empleadosDeLicenciaEn(
        ['e1', 'e2'],
        '2026-10-17',
      );

      expect([...res]).toEqual(['e1']);
      expect(condiciones).toContainEqual([
        'l.status = :status',
        { status: LeaveStatus.APPROVED },
      ]);
    });

    it('cuenta a los de licencia hoy; sin filas, cero', async () => {
      const { qb } = crearQb({ getRawOne: { n: '3' } });
      repoDelServicio.createQueryBuilder.mockReturnValue(qb);
      await expect(
        service.contarDeLicenciaEn('d1', '2026-10-17'),
      ).resolves.toBe(3);

      const vacio = crearQb({ getRawOne: undefined });
      repoDelServicio.createQueryBuilder.mockReturnValue(vacio.qb);
      await expect(
        service.contarDeLicenciaEn('d1', '2026-10-17'),
      ).resolves.toBe(0);
    });

    it('tieneLicencias consulta por el legajo', async () => {
      repoDeLaTransaccion.exists.mockResolvedValue(true);
      const manager = {
        getRepository: () => repoDeLaTransaccion,
      } as unknown as EntityManager;
      await expect(service.tieneLicencias(manager, 'e1')).resolves.toBe(true);
    });
  });
});
