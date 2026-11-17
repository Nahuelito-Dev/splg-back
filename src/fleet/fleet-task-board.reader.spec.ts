import { Brackets, Repository } from 'typeorm';
import { BoardColumn } from './domain/task-board';
import { MaintenanceDocumentKind } from './entities/maintenance-plan.entity';
import { MaintenanceTaskAttachment } from './entities/maintenance-task-attachment.entity';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from './entities/maintenance-task.entity';
import { FleetTaskBoardReader } from './fleet-task-board.reader';

/**
 * Un query builder de mentira que anota cada condición (también las de los
 * `Brackets`) con sus parámetros, y devuelve las filas que le toquen.
 */
class QbDePrueba {
  condiciones: string[] = [];
  parametros: Record<string, unknown> = {};
  orden: string[] = [];
  constructor(
    private readonly filas: MaintenanceTask[] = [],
    private readonly cuenta = 0,
  ) {}

  private anotar(cond: string | Brackets, params?: Record<string, unknown>) {
    if (cond instanceof Brackets) {
      const sub = new QbDePrueba();
      cond.whereFactory(sub as never);
      this.condiciones.push(`(${sub.condiciones.join(' | ')})`);
      Object.assign(this.parametros, sub.parametros);
    } else {
      this.condiciones.push(cond);
    }
    Object.assign(this.parametros, params ?? {});
    return this;
  }
  innerJoinAndSelect() {
    return this;
  }
  leftJoinAndSelect() {
    return this;
  }
  where(c: string | Brackets, p?: Record<string, unknown>) {
    return this.anotar(c, p);
  }
  andWhere(c: string | Brackets, p?: Record<string, unknown>) {
    return this.anotar(c, p);
  }
  orWhere(c: string | Brackets, p?: Record<string, unknown>) {
    return this.anotar(c, p);
  }
  orderBy(c: string) {
    this.orden.push(c);
    return this;
  }
  addOrderBy(c: string) {
    this.orden.push(c);
    return this;
  }
  getMany() {
    return Promise.resolve(this.filas);
  }
  getOne() {
    return Promise.resolve(this.filas[0] ?? null);
  }
  getCount() {
    return Promise.resolve(this.cuenta);
  }
}

const tarea = (
  id: string,
  status: MaintenanceTaskStatus,
  over: Partial<MaintenanceTask> = {},
) =>
  ({
    taskId: id,
    status,
    scheduledAt: null,
    performedAt: null,
    ...over,
  }) as MaintenanceTask;

describe('FleetTaskBoardReader', () => {
  let creados: QbDePrueba[];
  let filas: MaintenanceTask[];
  let reader: FleetTaskBoardReader;
  let adjuntos: { createQueryBuilder: jest.Mock };

  beforeEach(() => {
    creados = [];
    filas = [];
    const tasks = {
      createQueryBuilder: jest.fn(() => {
        const qb = new QbDePrueba(filas, 4);
        creados.push(qb);
        return qb;
      }),
    };
    const conteo = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([{ taskId: 'b', n: '3' }]),
    };
    adjuntos = { createQueryBuilder: jest.fn(() => conteo) };
    reader = new FleetTaskBoardReader(
      tasks as unknown as Repository<MaintenanceTask>,
      adjuntos as unknown as Repository<MaintenanceTaskAttachment>,
    );
  });

  it('siempre acota a la distribuidora, saca las canceladas y limita las hechas a los últimos 30 días', async () => {
    const ahora = new Date('2026-11-17T12:00:00.000Z');
    const { canceladas } = await reader.tablero('d1', {}, ahora);
    const [abiertas, canceladasQb] = creados;
    expect(abiertas.condiciones).toEqual(
      expect.arrayContaining([
        'task.distributor_id = :distributorId',
        'task.status <> :cancelada',
        '(task.status <> :hecha | task.performed_at >= :desde)',
      ]),
    );
    expect(abiertas.parametros).toMatchObject({
      distributorId: 'd1',
      desde: new Date('2026-10-18T12:00:00.000Z'),
    });
    expect(abiertas.orden[0]).toBe('task.board_position');
    expect(canceladasQb.condiciones).toEqual(
      expect.arrayContaining([
        'task.distributor_id = :distributorId',
        'task.status = :cancelada',
      ]),
    );
    expect(canceladas).toBe(4);
  });

  it('`doneSince` reemplaza los 30 días', async () => {
    await reader.tablero('d1', { doneSince: '2026-01-01T00:00:00.000Z' });
    expect(creados[0].parametros.desde).toEqual(
      new Date('2026-01-01T00:00:00.000Z'),
    );
  });

  it('aplica cada filtro a las abiertas y al conteo de canceladas', async () => {
    await reader.tablero('d1', {
      carId: 'c1',
      category: MaintenanceDocumentKind.VTV,
      employeeId: 'e1',
      dueBefore: '2026-12-31',
      q: 'ab_1%',
    });
    for (const qb of creados) {
      expect(qb.condiciones).toEqual(
        expect.arrayContaining([
          'task.car_id = :carId',
          'plan.document_kind = :tipo',
          '(task.assignee_employee_id = :empleado OR task.employee_id = :empleado)',
          'task.due_at <= :hasta',
        ]),
      );
      expect(
        qb.condiciones.some((c) => c.includes('car.car_patent ILIKE :q')),
      ).toBe(true);
      expect(qb.parametros).toMatchObject({
        carId: 'c1',
        tipo: 'vtv',
        empleado: 'e1',
        hasta: new Date('2026-12-31T00:00:00.000Z'),
        // `%` y `_` del texto no son comodines.
        q: '%ab\\_1\\%%',
      });
    }
  });

  it('`generic` incluye los planes sin tipo', async () => {
    await reader.tablero('d1', { category: MaintenanceDocumentKind.GENERIC });
    expect(creados[0].condiciones).toContain(
      '(plan.document_kind = :tipo OR plan.document_kind IS NULL)',
    );
  });

  it('reparte por columna: la vencida a la de su turno, las hechas la más reciente primero, con los adjuntos contados', async () => {
    filas = [
      tarea('a', MaintenanceTaskStatus.FORECAST),
      tarea('b', MaintenanceTaskStatus.SCHEDULED),
      tarea('c', MaintenanceTaskStatus.OVERDUE),
      tarea('d', MaintenanceTaskStatus.OVERDUE, { scheduledAt: new Date() }),
      tarea('e', MaintenanceTaskStatus.IN_PROGRESS),
      tarea('f', MaintenanceTaskStatus.DONE, {
        performedAt: new Date('2026-11-01T00:00:00Z'),
      }),
      tarea('g', MaintenanceTaskStatus.DONE, {
        performedAt: new Date('2026-11-10T00:00:00Z'),
      }),
    ];
    const { columnas } = await reader.tablero('d1', {});
    const ids = (c: BoardColumn) => columnas[c].map((t) => t.task.taskId);
    expect(ids(BoardColumn.FORECAST)).toEqual(['a', 'c']);
    expect(ids(BoardColumn.SCHEDULED)).toEqual(['b', 'd']);
    expect(ids(BoardColumn.IN_PROGRESS)).toEqual(['e']);
    expect(ids(BoardColumn.DONE)).toEqual(['g', 'f']);
    expect(columnas[BoardColumn.SCHEDULED][0].attachmentsCount).toBe(3);
    expect(columnas[BoardColumn.FORECAST][0].attachmentsCount).toBe(0);
  });

  it('una tarjeta: por id y empresa, o null', async () => {
    await expect(reader.tarjeta('x', 'd1')).resolves.toBeNull();
    expect(creados[0].condiciones).toEqual([
      'task.distributor_id = :distributorId',
      'task.task_id = :id',
    ]);
    expect(adjuntos.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('varias tarjetas: en el orden pedido, sin las que no son de la empresa', async () => {
    filas = [
      tarea('b', MaintenanceTaskStatus.SCHEDULED),
      tarea('a', MaintenanceTaskStatus.FORECAST),
    ];
    const tarjetas = await reader.tarjetas(['a', 'z', 'b'], 'd1');
    expect(tarjetas.map((t) => t.task.taskId)).toEqual(['a', 'b']);
    expect(creados[0].parametros).toMatchObject({
      distributorId: 'd1',
      ids: ['a', 'z', 'b'],
    });
    await expect(reader.tarjetas([], 'd1')).resolves.toEqual([]);
  });

  it('la columna de destino: de la empresa, sin la que se mueve, en el orden del tablero', async () => {
    const qb = new QbDePrueba([
      { taskId: 'a', boardPosition: 1024 } as MaintenanceTask,
    ]);
    const qbSelect = Object.assign(qb, { select: () => qb });
    const manager = {
      getRepository: () => ({ createQueryBuilder: () => qbSelect }),
    };
    const columna = await reader.columna(
      manager as never,
      'd1',
      BoardColumn.SCHEDULED,
      'yo',
    );
    expect(columna).toEqual([{ id: 'a', position: 1024 }]);
    expect(qb.parametros).toEqual({
      distributorId: 'd1',
      columna: 'scheduled',
      excluir: 'yo',
    });
    expect(qb.orden[0]).toBe('task.board_position');
  });
});
