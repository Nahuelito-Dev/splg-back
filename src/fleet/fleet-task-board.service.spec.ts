import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { FindOperator, Repository } from 'typeorm';
import { BoardColumn, BoardMoveTarget } from './domain/task-board';
import { MoveFleetTaskDto } from './dto/task-board.dto';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from './entities/maintenance-task.entity';
import { FleetTaskBoardNotifier } from './fleet-task-board.notifier';
import { FleetTaskBoardReader } from './fleet-task-board.reader';
import { FleetTaskBoardService } from './fleet-task-board.service';
import { PlanningCaseCloser } from './planner/planning-case-closer.service';

const ID = '11111111-1111-4111-8111-111111111111';
const ACTUALIZADA = new Date('2026-11-17T12:00:00.123Z');
const TURNO = new Date('2026-12-02T13:00:00.000Z');

/** Código del cuerpo de la excepción (`conCodigo`). */
const codigo = (e: unknown) =>
  ((e as HttpException).getResponse() as { code?: string }).code;

describe('FleetTaskBoardService.mover', () => {
  let service: FleetTaskBoardService;
  let fila: MaintenanceTask | null;
  let orden: string[];
  let repo: { findOne: jest.Mock; save: jest.Mock; update: jest.Mock };
  let lector: { columna: jest.Mock; tarjeta: jest.Mock; tablero: jest.Mock };
  let avisos: { avisar: jest.Mock; avisarVarias: jest.Mock };
  let query: jest.Mock;
  let casos: { reprogramarConfirmado: jest.Mock };
  let transaccionFalla: Error | null;

  const tarea = (over: Partial<MaintenanceTask> = {}): MaintenanceTask =>
    ({
      taskId: ID,
      distributorId: 'd1',
      status: MaintenanceTaskStatus.SCHEDULED,
      scheduledAt: TURNO,
      boardPosition: 1024,
      updatedAt: ACTUALIZADA,
      ...over,
    }) as MaintenanceTask;

  const mover = (dto: Partial<MoveFleetTaskDto>, esperado?: Date) =>
    service.mover(
      ID,
      { to: BoardMoveTarget.SCHEDULED, ...dto } as MoveFleetTaskDto,
      'd1',
      'u1',
      esperado,
    );

  /** El error que tiró, para mirar su clase y su `code` sin `expect` en un `catch`. */
  const errorDe = (p: Promise<unknown>): Promise<unknown> =>
    p.then(
      () => null,
      (e: unknown) => e,
    );

  beforeEach(() => {
    orden = [];
    transaccionFalla = null;
    fila = tarea();
    repo = {
      findOne: jest.fn(() => Promise.resolve(fila)),
      save: jest.fn((t: MaintenanceTask) => {
        orden.push('save');
        return Promise.resolve(t);
      }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    query = jest.fn(() => {
      orden.push('cerrojo');
      return Promise.resolve([]);
    });
    const manager = { getRepository: () => repo, query };
    const tasks = {
      manager: {
        transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) => {
          const r = await cb(manager);
          if (transaccionFalla) throw transaccionFalla;
          orden.push('commit');
          return r;
        }),
      },
    };
    lector = {
      columna: jest.fn().mockResolvedValue([
        { id: 'a', position: 1024 },
        { id: 'b', position: 2048 },
      ]),
      tarjeta: jest.fn(() =>
        Promise.resolve({
          task: {
            ...fila,
            plan: { name: 'VTV', documentKind: 'vtv', leadTimeDays: 30 },
          },
          attachmentsCount: 1,
        }),
      ),
      tablero: jest.fn(),
    };
    avisos = {
      avisarVarias: jest.fn(() => {
        orden.push('reordenadas');
        return Promise.resolve();
      }),
      avisar: jest.fn(() => {
        orden.push('aviso');
        return Promise.resolve();
      }),
    };
    casos = { reprogramarConfirmado: jest.fn().mockResolvedValue(undefined) };
    service = new FleetTaskBoardService(
      tasks as unknown as Repository<MaintenanceTask>,
      lector as unknown as FleetTaskBoardReader,
      avisos as unknown as FleetTaskBoardNotifier,
      casos as unknown as PlanningCaseCloser,
    );
  });

  it('forecast → scheduled: fija el turno, cambia el estado y va al final', async () => {
    fila = tarea({
      status: MaintenanceTaskStatus.FORECAST,
      scheduledAt: null,
    });
    const card = await mover({
      to: BoardMoveTarget.SCHEDULED,
      scheduledAt: TURNO.toISOString(),
    });
    const guardada = (
      repo.save.mock.calls[0] as unknown[]
    )[0] as MaintenanceTask;
    expect(guardada).toMatchObject({
      status: MaintenanceTaskStatus.SCHEDULED,
      scheduledAt: TURNO,
      boardPosition: 3072,
    });
    expect(lector.columna).toHaveBeenCalledWith(
      expect.anything(),
      'd1',
      BoardColumn.SCHEDULED,
      ID,
    );
    expect(card).toMatchObject({ id: ID, column: 'scheduled' });
  });

  it('forecast → scheduled sin turno: 400 FLEET_TASK_SCHEDULED_AT_REQUIRED y no guarda', async () => {
    fila = tarea({ status: MaintenanceTaskStatus.FORECAST, scheduledAt: null });
    const e = await errorDe(mover({ to: BoardMoveTarget.SCHEDULED }));
    expect(e).toBeInstanceOf(BadRequestException);
    expect(codigo(e)).toBe('FLEET_TASK_SCHEDULED_AT_REQUIRED');
    expect(repo.save).not.toHaveBeenCalled();
    expect(avisos.avisar).not.toHaveBeenCalled();
  });

  it('scheduled → forecast: borra el turno y cancela la ventana confirmada del planificador', async () => {
    await mover({ to: BoardMoveTarget.FORECAST });
    expect(casos.reprogramarConfirmado).toHaveBeenCalledWith(
      expect.anything(),
      ID,
      null,
      'u1',
    );
    expect((repo.save.mock.calls[0] as unknown[])[0]).toMatchObject({
      status: MaintenanceTaskStatus.FORECAST,
      scheduledAt: null,
    });
  });

  it('scheduled → in_progress conserva el turno', async () => {
    await mover({ to: BoardMoveTarget.IN_PROGRESS });
    expect((repo.save.mock.calls[0] as unknown[])[0]).toMatchObject({
      status: MaintenanceTaskStatus.IN_PROGRESS,
      scheduledAt: TURNO,
    });
    expect(casos.reprogramarConfirmado).not.toHaveBeenCalled();
  });

  it('in_progress → scheduled', async () => {
    fila = tarea({ status: MaintenanceTaskStatus.IN_PROGRESS });
    await mover({ to: BoardMoveTarget.SCHEDULED });
    expect((repo.save.mock.calls[0] as unknown[])[0]).toMatchObject({
      status: MaintenanceTaskStatus.SCHEDULED,
    });
  });

  it('a la misma columna sólo reordena: el estado no cambia', async () => {
    await mover({ to: BoardMoveTarget.SCHEDULED, afterId: 'a' });
    expect((repo.save.mock.calls[0] as unknown[])[0]).toMatchObject({
      status: MaintenanceTaskStatus.SCHEDULED,
      scheduledAt: TURNO,
      boardPosition: 1536,
    });
  });

  it('antes de la primera de la columna', async () => {
    await mover({ to: BoardMoveTarget.SCHEDULED, beforeId: 'a' });
    expect((repo.save.mock.calls[0] as unknown[])[0]).toMatchObject({
      boardPosition: 0,
    });
  });

  it('una tarea vencida reordena en su columna de origen sin perder el estado', async () => {
    fila = tarea({ status: MaintenanceTaskStatus.OVERDUE, scheduledAt: null });
    await mover({ to: BoardMoveTarget.FORECAST, afterId: 'b' });
    expect((repo.save.mock.calls[0] as unknown[])[0]).toMatchObject({
      status: MaintenanceTaskStatus.OVERDUE,
      boardPosition: 3072,
    });
    expect(lector.columna).toHaveBeenCalledWith(
      expect.anything(),
      'd1',
      BoardColumn.FORECAST,
      ID,
    );
  });

  it('sin hueco entre las vecinas renumera sólo la columna (sin mover `updated_at`), la ubica y avisa `reordered`', async () => {
    lector.columna.mockResolvedValue([
      { id: 'a', position: 1 },
      { id: 'b', position: 1 + 1e-9 },
    ]);
    await mover({ to: BoardMoveTarget.SCHEDULED, afterId: 'a' });
    const llamadas = repo.update.mock.calls as [
      { taskId: string; distributorId: string; status: FindOperator<string[]> },
      { boardPosition: number; updatedAt: () => string },
    ][];
    expect(
      llamadas.map(([donde, que]) => [donde.taskId, que.boardPosition]),
    ).toEqual([
      ['a', 1024],
      ['b', 2048],
    ]);
    for (const [donde, que] of llamadas) {
      expect(donde.distributorId).toBe('d1');
      // Sólo si la tarjeta sigue en la columna (con el cerrojo del tablero tomado).
      expect(donde.status.value).toEqual(['scheduled', 'overdue']);
      expect(que.updatedAt()).toBe('"updated_at"');
    }
    expect((repo.save.mock.calls[0] as unknown[])[0]).toMatchObject({
      boardPosition: 1536,
    });
    expect(avisos.avisarVarias).toHaveBeenCalledWith(
      'd1',
      ['a', 'b'],
      'reordered',
    );
    expect(orden.slice(-2)).toEqual(['aviso', 'reordenadas']);
  });

  it('sin renumerar no avisa `reordered`', async () => {
    await mover({ to: BoardMoveTarget.SCHEDULED, afterId: 'a' });
    expect(avisos.avisarVarias).not.toHaveBeenCalled();
  });

  it('toma el cerrojo del tablero de la empresa después del lock de la fila y antes de calcular', async () => {
    await mover({ to: BoardMoveTarget.IN_PROGRESS });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock') as string,
      ['d1'],
    );
    expect((query.mock.calls[0] as unknown[])[0]).toContain(
      "set_config('splg.tablero_posicion', 'manual', true)",
    );
    expect(repo.findOne.mock.invocationCallOrder[0]).toBeLessThan(
      query.mock.invocationCallOrder[0],
    );
    expect(query.mock.invocationCallOrder[0]).toBeLessThan(
      lector.columna.mock.invocationCallOrder[0],
    );
  });

  it('forecast → scheduled con `scheduledAt: null`: 400 FLEET_TASK_SCHEDULED_AT_REQUIRED (null no es un turno)', async () => {
    fila = tarea({ status: MaintenanceTaskStatus.FORECAST, scheduledAt: null });
    const e = await errorDe(
      mover({
        to: BoardMoveTarget.SCHEDULED,
        scheduledAt: null as unknown as string,
      }),
    );
    expect(codigo(e)).toBe('FLEET_TASK_SCHEDULED_AT_REQUIRED');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it.each([MaintenanceTaskStatus.SCHEDULED, MaintenanceTaskStatus.IN_PROGRESS])(
    'desde %s, `scheduledAt: null` no borra el turno (cuenta como ausente)',
    async (status) => {
      fila = tarea({ status });
      await mover({
        to: BoardMoveTarget.SCHEDULED,
        scheduledAt: null as unknown as string,
      });
      expect((repo.save.mock.calls[0] as unknown[])[0]).toMatchObject({
        scheduledAt: TURNO,
      });
      expect(casos.reprogramarConfirmado).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['de otra columna o de otra empresa', { afterId: 'zzz' }],
    ['la misma tarjeta', { beforeId: ID }],
    ['al revés', { afterId: 'b', beforeId: 'a' }],
  ])(
    'una tarjeta de referencia %s: 400 FLEET_TASK_NEIGHBOR_INVALID',
    async (_caso, vecinas) => {
      const e = await errorDe(
        mover({ to: BoardMoveTarget.SCHEDULED, ...vecinas }),
      );
      expect(e).toBeInstanceOf(BadRequestException);
      expect(codigo(e)).toBe('FLEET_TASK_NEIGHBOR_INVALID');
      expect(repo.save).not.toHaveBeenCalled();
    },
  );

  it('no existe o es de otra distribuidora: 404 (busca por id y empresa, bloqueada)', async () => {
    fila = null;
    await expect(mover({})).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { taskId: ID, distributorId: 'd1' },
      lock: { mode: 'pessimistic_write' },
    });
  });

  it.each([
    [MaintenanceTaskStatus.DONE, BoardMoveTarget.SCHEDULED],
    [MaintenanceTaskStatus.CANCELLED, BoardMoveTarget.FORECAST],
  ])('desde %s: 409 FLEET_TASK_CLOSED', async (status, to) => {
    fila = tarea({ status });
    const e = await errorDe(mover({ to }));
    expect(e).toBeInstanceOf(ConflictException);
    expect(codigo(e)).toBe('FLEET_TASK_CLOSED');
  });

  it.each([
    [MaintenanceTaskStatus.FORECAST, BoardMoveTarget.IN_PROGRESS],
    [MaintenanceTaskStatus.IN_PROGRESS, BoardMoveTarget.FORECAST],
  ])('%s → %s: 409 FLEET_TASK_TRANSITION_NOT_ALLOWED', async (status, to) => {
    fila = tarea({ status, scheduledAt: null });
    const e = await errorDe(mover({ to }));
    expect(e).toBeInstanceOf(ConflictException);
    expect(codigo(e)).toBe('FLEET_TASK_TRANSITION_NOT_ALLOWED');
  });

  it('un turno con otro destino: 400 FLEET_TASK_SCHEDULED_AT_NOT_ALLOWED', async () => {
    const e = await errorDe(
      mover({
        to: BoardMoveTarget.IN_PROGRESS,
        scheduledAt: TURNO.toISOString(),
      }),
    );
    expect(codigo(e)).toBe('FLEET_TASK_SCHEDULED_AT_NOT_ALLOWED');
  });

  it('precondición vieja: 409 FLEET_TASK_STALE y no guarda', async () => {
    const e = await errorDe(mover({}, new Date(ACTUALIZADA.getTime() - 1)));
    expect(e).toBeInstanceOf(ConflictException);
    expect(codigo(e)).toBe('FLEET_TASK_STALE');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('precondición al día: mueve', async () => {
    await mover({}, new Date(ACTUALIZADA.getTime()));
    expect(repo.save).toHaveBeenCalled();
  });

  it('dos movimientos: el segundo lee la fila bloqueada como la dejó el primero', async () => {
    fila = tarea({ status: MaintenanceTaskStatus.FORECAST, scheduledAt: null });
    repo.save.mockImplementation((t: MaintenanceTask) => {
      fila = { ...t };
      return Promise.resolve(t);
    });
    await mover({
      to: BoardMoveTarget.SCHEDULED,
      scheduledAt: TURNO.toISOString(),
    });
    // El segundo parte de `scheduled` (lo que dejó el primero), no de `forecast`.
    await mover({ to: BoardMoveTarget.IN_PROGRESS });
    expect(fila).toMatchObject({ status: MaintenanceTaskStatus.IN_PROGRESS });
  });

  it('el socket sale después del commit', async () => {
    await mover({ to: BoardMoveTarget.IN_PROGRESS });
    expect(orden).toEqual(['cerrojo', 'save', 'commit', 'aviso']);
    expect(avisos.avisar).toHaveBeenCalledWith('d1', ID, 'moved');
  });

  it('si la transacción falla no avisa', async () => {
    transaccionFalla = new ConflictException('chocó');
    await expect(mover({ to: BoardMoveTarget.IN_PROGRESS })).rejects.toBe(
      transaccionFalla,
    );
    expect(avisos.avisar).not.toHaveBeenCalled();
  });
});

describe('FleetTaskBoardService.tablero', () => {
  it('lee el tablero de la empresa y lo arma con el mapper', async () => {
    const lector = {
      tablero: jest.fn().mockResolvedValue({
        columnas: {
          forecast: [],
          scheduled: [],
          in_progress: [],
          done: [],
        },
        canceladas: 2,
      }),
    };
    const service = new FleetTaskBoardService(
      {} as Repository<MaintenanceTask>,
      lector as unknown as FleetTaskBoardReader,
      {} as FleetTaskBoardNotifier,
    );
    await expect(service.tablero('d1', { carId: 'c1' })).resolves.toEqual({
      columns: { forecast: [], scheduled: [], in_progress: [], done: [] },
      cancelledCount: 2,
    });
    expect(lector.tablero).toHaveBeenCalledWith(
      'd1',
      { carId: 'c1' },
      expect.any(Date),
    );
  });
});
