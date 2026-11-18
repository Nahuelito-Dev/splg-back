import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AttendanceService } from './attendance.service';
import {
  AttendanceSource,
  EmployeeAttendance,
} from './entities/employee-attendance.entity';
import { EmployeeService } from '../employee/employee.service';
import { Employee, EmployeeStatus } from '../employee/entities/employee.entity';
import { diaArgentino, sumarDias } from '../common/utils/dias-argentina';

function crearQb(resultados: {
  getOne?: unknown;
  getManyAndCount?: [unknown[], number];
  getRawMany?: unknown[];
  getMany?: unknown[];
}) {
  const condiciones: Array<[string, unknown]> = [];
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'innerJoinAndSelect',
    'select',
    'addSelect',
    'where',
    'andWhere',
    'groupBy',
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
  qb.getManyAndCount = jest
    .fn()
    .mockResolvedValue(resultados.getManyAndCount ?? [[], 0]);
  qb.getRawMany = jest.fn().mockResolvedValue(resultados.getRawMany ?? []);
  qb.getOne = jest.fn().mockResolvedValue(resultados.getOne ?? null);
  qb.getMany = jest.fn().mockResolvedValue(resultados.getMany ?? []);
  return { qb, condiciones };
}

describe('AttendanceService', () => {
  let service: AttendanceService;
  let guardadas: EmployeeAttendance[];
  let repoTx: {
    exists: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    findOneOrFail: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let superposicion: ReturnType<typeof crearQb>;
  let repoServicio: {
    createQueryBuilder: jest.Mock;
    count: jest.Mock;
  };
  let employees: {
    findActivo: jest.Mock;
    findByUserId: jest.Mock;
    bloquear: jest.Mock;
  };

  const legajo = {
    employeeId: 'e1',
    distributorId: 'd1',
    firstName: 'Ana',
    lastName: 'Pérez',
    fileNumber: '0001',
    status: EmployeeStatus.ACTIVE,
  } as Employee;

  const jornada = (over: Partial<EmployeeAttendance> = {}) =>
    ({
      attendanceId: 'a1',
      distributorId: 'd1',
      employeeId: 'e1',
      workDate: '2026-03-02',
      checkInAt: new Date('2026-03-02T11:00:00Z'),
      checkOutAt: null,
      source: AttendanceSource.PANEL,
      notes: null,
      ...over,
    }) as EmployeeAttendance;

  beforeEach(() => {
    // Mediodía argentino para que "hoy", ayer y las marcas de entrada/salida
    // no cambien si la suite corre cerca de medianoche.
    jest.useFakeTimers({ now: new Date('2026-10-15T15:00:00Z') });
    guardadas = [];
    superposicion = crearQb({});
    repoTx = {
      exists: jest.fn().mockResolvedValue(false),
      create: jest.fn((j: Partial<EmployeeAttendance>) => j),
      save: jest.fn((j: EmployeeAttendance) => {
        guardadas.push({ ...j });
        return Promise.resolve({
          ...j,
          attendanceId: j.attendanceId ?? 'nueva',
        });
      }),
      findOne: jest.fn(),
      findOneOrFail: jest.fn(),
      createQueryBuilder: jest.fn(() => superposicion.qb),
    };
    const manager = {
      getRepository: () => repoTx,
    } as unknown as EntityManager;
    const dataSource = {
      transaction: (fn: (m: EntityManager) => Promise<unknown>) => fn(manager),
    } as unknown as DataSource;
    repoServicio = { createQueryBuilder: jest.fn(), count: jest.fn() };
    employees = {
      findActivo: jest.fn().mockResolvedValue(legajo),
      findByUserId: jest.fn().mockResolvedValue(legajo),
      bloquear: jest.fn().mockResolvedValue(legajo),
    };
    service = new AttendanceService(
      repoServicio as unknown as Repository<EmployeeAttendance>,
      dataSource,
      employees as unknown as EmployeeService,
    );
  });

  afterEach(() => jest.useRealTimers());

  describe('register (CU-189)', () => {
    it('crea la jornada con el día argentino del ingreso y origen panel', async () => {
      const res = await service.register(
        'e1',
        { checkInAt: '2026-03-03T01:30:00.000Z' }, // 22:30 del 2 en Argentina
        'd1',
        'admin-1',
      );

      expect(guardadas[0]).toMatchObject({
        employeeId: 'e1',
        workDate: '2026-03-02',
        checkOutAt: null,
        source: AttendanceSource.PANEL,
        recordedByUserId: 'admin-1',
      });
      expect(res.employee.fileNumber).toBe('0001');
      expect(employees.findActivo).toHaveBeenCalledWith(
        'e1',
        'd1',
        expect.anything(),
      );
    });

    it('una carga con egreso se acepta aunque el empleado tenga otra jornada abierta, si no se pisan', async () => {
      repoTx.exists.mockResolvedValue(true);
      await service.register(
        'e1',
        {
          checkInAt: '2026-03-02T11:00:00.000Z',
          checkOutAt: '2026-03-02T19:00:00.000Z',
        },
        'd1',
        'admin-1',
      );
      expect(guardadas).toHaveLength(1);
    });

    it('una jornada que se pisa con otra del mismo empleado es 409, con o sin egreso', async () => {
      superposicion = crearQb({
        getOne: jornada({ attendanceId: 'a9', workDate: '2026-03-02' }),
      });
      await expect(
        service.register(
          'e1',
          {
            checkInAt: '2026-03-02T11:00:00.000Z',
            checkOutAt: '2026-03-02T19:00:00.000Z',
          },
          'd1',
          'admin-1',
        ),
      ).rejects.toThrow(/se superpone/);
      await expect(
        service.register(
          'e1',
          { checkInAt: '2026-03-02T11:00:00.000Z' },
          'd1',
          'admin-1',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(guardadas).toEqual([]);
    });

    it('rechaza un ingreso o un egreso futuros (400)', async () => {
      const manana = new Date(Date.now() + 86_400_000).toISOString();
      await expect(
        service.register('e1', { checkInAt: manana }, 'd1', 'a'),
      ).rejects.toThrow(/Hora de ingreso: no puede ser una fecha futura/);
      await expect(
        service.register(
          'e1',
          { checkInAt: '2026-03-02T11:00:00.000Z', checkOutAt: manana },
          'd1',
          'a',
        ),
      ).rejects.toThrow(/Hora de salida: no puede ser una fecha futura/);
      expect(employees.findActivo).not.toHaveBeenCalled();
    });

    it('con egreso queda cerrada', async () => {
      await service.register(
        'e1',
        {
          checkInAt: '2026-03-02T11:00:00.000Z',
          checkOutAt: '2026-03-02T19:00:00.000Z',
        },
        'd1',
        'admin-1',
      );
      expect(guardadas[0].checkOutAt).toEqual(new Date('2026-03-02T19:00:00Z'));
    });

    it('un egreso que no es posterior al ingreso es 400', async () => {
      await expect(
        service.register(
          'e1',
          {
            checkInAt: '2026-03-02T11:00:00.000Z',
            checkOutAt: '2026-03-02T11:00:00.000Z',
          },
          'd1',
          'admin-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(employees.findActivo).not.toHaveBeenCalled();
    });

    it('con una jornada abierta, rechaza por conflicto', async () => {
      repoTx.exists.mockResolvedValue(true);
      await expect(
        service.register(
          'e1',
          { checkInAt: '2026-03-02T11:00:00.000Z' },
          'd1',
          'admin-1',
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          code: 'WORKDAY_ALREADY_OPEN',
          message: expect.stringContaining('jornada abierta') as string,
        },
      });
      expect(guardadas).toEqual([]);
    });

    it('un empleado egresado (409) o ajeno (404) viene de EmployeeService', async () => {
      employees.findActivo.mockRejectedValue(new ConflictException());
      await expect(
        service.register(
          'e1',
          { checkInAt: '2026-03-02T11:00:00.000Z' },
          'd1',
          'a',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      employees.findActivo.mockRejectedValue(new NotFoundException());
      await expect(
        service.register(
          'e1',
          { checkInAt: '2026-03-02T11:00:00.000Z' },
          'd1',
          'a',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('correct (CU-313)', () => {
    beforeEach(() => {
      repoTx.findOne.mockResolvedValue(jornada());
      repoTx.findOneOrFail.mockResolvedValue(jornada());
    });

    it('cambia el egreso, deja la nota y recalcula el día', async () => {
      const res = await service.correct(
        'a1',
        { checkOutAt: '2026-03-02T19:00:00.000Z', notes: 'Olvidó marcar' },
        'd1',
      );

      expect(res.checkOutAt).toEqual(new Date('2026-03-02T19:00:00Z'));
      expect(res.notes).toBe('Olvidó marcar');
      expect(res.workDate).toBe('2026-03-02');
    });

    it('una corrección hacia el futuro es 400 y una que pisa otra jornada, 409', async () => {
      const manana = new Date(Date.now() + 86_400_000).toISOString();
      await expect(
        service.correct('a1', { checkOutAt: manana, notes: 'x' }, 'd1'),
      ).rejects.toThrow(/no puede ser una fecha futura/);
      superposicion = crearQb({ getOne: jornada({ attendanceId: 'a2' }) });
      await expect(
        service.correct(
          'a1',
          { checkOutAt: '2026-03-02T19:00:00.000Z', notes: 'x' },
          'd1',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('las notas de correcciones sucesivas se acumulan', async () => {
      repoTx.findOneOrFail.mockResolvedValue(jornada({ notes: 'Primera' }));
      const res = await service.correct(
        'a1',
        { checkInAt: '2026-03-02T10:00:00.000Z', notes: 'Segunda' },
        'd1',
      );
      expect(res.notes).toBe('Primera\nSegunda');
    });

    it('si el egreso queda antes del ingreso es 400', async () => {
      await expect(
        service.correct(
          'a1',
          { checkOutAt: '2026-03-02T10:00:00.000Z', notes: 'x' },
          'd1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(guardadas).toEqual([]);
    });

    it('sin ingreso ni egreso no hay nada que corregir (400)', async () => {
      await expect(
        service.correct('a1', { notes: 'x' }, 'd1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('una jornada de otra distribuidora es 404', async () => {
      repoTx.findOne.mockResolvedValue(null);
      await expect(
        service.correct(
          'a1',
          { checkOutAt: '2026-03-02T19:00:00.000Z', notes: 'x' },
          'd2',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repoTx.findOne).toHaveBeenCalledWith({
        where: { attendanceId: 'a1', distributorId: 'd2' },
      });
    });
  });

  describe('findAll (CU-314)', () => {
    it('sin ningún filtro trae el día de hoy y cuenta presentes y rezagadas', async () => {
      const hoy = diaArgentino();
      const lista = crearQb({ getManyAndCount: [[jornada()], 1] });
      const conteo = crearQb({
        getRawMany: [
          { workDate: hoy, n: '2' },
          { workDate: sumarDias(hoy, -1), n: '1' },
        ],
      });
      repoServicio.createQueryBuilder
        .mockReturnValueOnce(lista.qb)
        .mockReturnValueOnce(conteo.qb);

      const res = await service.findAll({}, 'd1');

      expect(res).toMatchObject({ total: 1, presentToday: 2, staleOpen: 1 });
      expect(lista.condiciones).toContainEqual([
        'a.workDate = :dia',
        { dia: hoy },
      ]);
    });

    it('con filtros no fuerza el día de hoy', async () => {
      const lista = crearQb({});
      repoServicio.createQueryBuilder
        .mockReturnValueOnce(lista.qb)
        .mockReturnValueOnce(crearQb({}).qb);

      await service.findAll(
        { open: true, employeeId: 'e1', from: '2026-03-01', to: '2026-03-31' },
        'd1',
      );

      expect(lista.condiciones.map(([c]) => c)).toEqual([
        'a.distributorId = :distributorId',
        'a.workDate >= :from',
        'a.workDate <= :to',
        'a.employeeId = :employeeId',
        'a.checkOutAt IS NULL',
      ]);
    });

    it('un período invertido es 400', async () => {
      await expect(
        service.findAll({ from: '2026-05-01', to: '2026-04-01' }, 'd1'),
      ).rejects.toThrow(
        'Hasta: la fecha final no puede ser anterior a la inicial',
      );
    });
  });

  describe('marcas del chofer (CU-190, CU-315)', () => {
    it('inicia la jornada con origen app y el instante actual', async () => {
      const antes = Date.now();
      const { jornada: res, created } = await service.checkIn('u1');

      expect(created).toBe(true);
      expect(employees.bloquear).toHaveBeenCalled();
      expect(guardadas[0]).toMatchObject({
        source: AttendanceSource.DRIVER_APP,
        recordedByUserId: 'u1',
        checkOutAt: null,
      });
      expect(res.checkInAt.getTime()).toBeGreaterThanOrEqual(antes);
    });

    it('sin legajo vinculado, o egresado, rechaza por conflicto', async () => {
      employees.findByUserId.mockResolvedValue(null);
      await expect(service.checkIn('u1')).rejects.toThrow(
        'Tu cuenta no está vinculada a un legajo',
      );
      employees.findByUserId.mockResolvedValue(legajo);
      employees.bloquear.mockResolvedValue({
        ...legajo,
        status: EmployeeStatus.TERMINATED,
      });
      await expect(service.checkIn('u1')).rejects.toThrow(
        'Tu legajo está egresado',
      );
      await expect(service.checkOut('u1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('es idempotente: con una jornada de hoy abierta desde la app, la devuelve sin crear otra', async () => {
      repoTx.findOne.mockResolvedValue(
        jornada({
          source: AttendanceSource.DRIVER_APP,
          workDate: diaArgentino(),
        }),
      );
      const res = await service.checkIn('u1');
      expect(res.created).toBe(false);
      expect(res.jornada.attendanceId).toBe('a1');
      expect(guardadas).toEqual([]);
    });

    it('una abierta de otro día, o cargada desde el panel, no se devuelve: es conflicto', async () => {
      repoTx.exists.mockResolvedValue(true);
      repoTx.findOne.mockResolvedValue(
        jornada({
          source: AttendanceSource.DRIVER_APP,
          workDate: sumarDias(diaArgentino(), -1),
        }),
      );
      await expect(service.checkIn('u1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      repoTx.findOne.mockResolvedValue(
        jornada({ source: AttendanceSource.PANEL, workDate: diaArgentino() }),
      );
      await expect(service.checkIn('u1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('finaliza cerrando la jornada abierta con el instante actual', async () => {
      repoTx.findOne.mockResolvedValue(
        jornada({
          checkInAt: new Date(Date.now() - 3_600_000),
          workDate: diaArgentino(),
        }),
      );
      const res = await service.checkOut('u1');
      expect(res.checkOutAt).toBeInstanceOf(Date);
      expect(res.checkOutAt?.getTime()).toBeGreaterThan(
        res.checkInAt.getTime(),
      );
    });

    it('una jornada abierta de un día anterior no se cierra con la hora de hoy: se corrige desde el panel', async () => {
      repoTx.findOne.mockResolvedValue(
        jornada({ workDate: sumarDias(diaArgentino(), -1) }),
      );
      await expect(service.checkOut('u1')).rejects.toThrow(
        /corregila desde el panel/,
      );
      expect(guardadas).toEqual([]);
    });

    it('sin jornada abierta, finalizar es conflicto', async () => {
      repoTx.findOne.mockResolvedValue(null);
      await expect(service.checkOut('u1')).rejects.toThrow(
        'No tenés una jornada abierta',
      );
    });
  });

  describe('jornadaAbierta (app del chofer)', () => {
    beforeEach(() => {
      (repoServicio as unknown as { findOne: jest.Mock }).findOne = jest.fn();
    });

    it('devuelve la abierta con su legajo, aunque sea de un día anterior', async () => {
      const abierta = jornada({ workDate: sumarDias(diaArgentino(), -1) });
      (
        repoServicio as unknown as { findOne: jest.Mock }
      ).findOne.mockResolvedValue(abierta);
      const res = await service.jornadaAbierta('u1');
      expect(res?.attendanceId).toBe('a1');
      expect(res?.employee.employeeId).toBe('e1');
    });

    it('sin jornada abierta o sin legajo vinculado devuelve null', async () => {
      (
        repoServicio as unknown as { findOne: jest.Mock }
      ).findOne.mockResolvedValue(null);
      await expect(service.jornadaAbierta('u1')).resolves.toBeNull();
      employees.findByUserId.mockResolvedValue(null);
      await expect(service.jornadaAbierta('u1')).resolves.toBeNull();
    });
  });

  describe('lecturas auxiliares', () => {
    it('abiertasAnteriores trae todas las abiertas de días anteriores, no sólo ayer', async () => {
      const { qb, condiciones } = crearQb({ getMany: [jornada()] });
      repoServicio.createQueryBuilder.mockReturnValue(qb);
      await expect(
        service.abiertasAnteriores('2026-03-02'),
      ).resolves.toHaveLength(1);
      expect(condiciones).toContainEqual([
        'a.workDate < :dia',
        { dia: '2026-03-02' },
      ]);
      expect(condiciones.map(([c]) => c)).toContain('a.checkOutAt IS NULL');
    });

    it('contarPresentes cuenta sólo las abiertas de hoy: la misma cifra que la grilla', async () => {
      repoServicio.count.mockResolvedValue(4);
      await expect(service.contarPresentes('d1')).resolves.toBe(4);
      expect(repoServicio.count).toHaveBeenCalledWith({
        where: {
          distributorId: 'd1',
          checkOutAt: expect.anything() as unknown,
          workDate: diaArgentino(),
        },
      });
    });

    it('tieneJornadas consulta por el legajo', async () => {
      repoTx.exists.mockResolvedValue(true);
      const manager = {
        getRepository: () => repoTx,
      } as unknown as EntityManager;
      await expect(service.tieneJornadas(manager, 'e1')).resolves.toBe(true);
    });
  });
});
