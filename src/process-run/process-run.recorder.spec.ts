import { Repository } from 'typeorm';
import {
  ProcessName,
  ProcessRunStatus,
  RunTrigger,
} from './domain/process-catalog';
import { ProcessRun } from './entities/process-run.entity';
import {
  conDisparo,
  marcarSaltada,
  registrarErrorAtrapado,
} from './process-run.context';
import {
  ConRegistro,
  ProcessRunRecorder,
  resultadoDeCorrida,
} from './process-run.recorder';

function armar(falla: { insert?: boolean; update?: boolean } = {}) {
  const insertados: Record<string, unknown>[] = [];
  const cierres: Record<string, unknown>[] = [];
  const qb = {
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockImplementation((v: Record<string, unknown>) => {
      insertados.push(v);
      return qb;
    }),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockImplementation((v: Record<string, unknown>) => {
      cierres.push(v);
      return qb;
    }),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockImplementation(() => {
      const abriendo =
        qb.insert.mock.calls.length > insertados.length - 1 &&
        insertados.length > cierres.length;
      if (abriendo && falla.insert)
        return Promise.reject(new Error('tabla sin migrar'));
      if (!abriendo && falla.update)
        return Promise.reject(new Error('base caída'));
      return Promise.resolve({
        identifiers: [{ runId: `run-${insertados.length}` }],
      });
    }),
  };
  const repo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
  const recorder = new ProcessRunRecorder(
    repo as unknown as Repository<ProcessRun>,
  );
  return { recorder, insertados, cierres };
}

describe('resultadoDeCorrida', () => {
  it('un número es processed; un objeto aporta sus números', () => {
    expect(resultadoDeCorrida(3)).toEqual({
      counters: { processed: 3 },
      status: ProcessRunStatus.OK,
    });
    expect(resultadoDeCorrida({ offers: 2, name: 'x' }).counters).toEqual({
      offers: 2,
    });
  });
  it('errores mayores a cero dejan la corrida parcial', () => {
    expect(resultadoDeCorrida({ processed: 5, errors: 1 }).status).toBe(
      ProcessRunStatus.PARTIAL,
    );
    expect(resultadoDeCorrida({ processed: 5, errors: 0 }).status).toBe(
      ProcessRunStatus.OK,
    );
  });
  it('lo que no es número ni objeto no suma', () => {
    expect(resultadoDeCorrida(undefined).counters).toEqual({});
  });
});

describe('ProcessRunRecorder', () => {
  it('registra una corrida ok con sus contadores y devuelve el valor tal cual', async () => {
    const { recorder, insertados, cierres } = armar();
    const valor = await recorder.ejecutar(
      ProcessName.COVERAGE_ZONE_EXPIRY,
      null,
      () => Promise.resolve(4),
    );
    expect(valor).toBe(4);
    expect(insertados[0]).toMatchObject({
      process: 'coverage_zone_expiry',
      distributorId: null,
      status: ProcessRunStatus.RUNNING,
      trigger: RunTrigger.CRON,
    });
    expect(cierres[0]).toMatchObject({
      status: ProcessRunStatus.OK,
      counters: { processed: 4 },
      error: null,
    });
  });

  it('una corrida con errores en los contadores queda partial', async () => {
    const { recorder, cierres } = armar();
    await recorder.ejecutar(ProcessName.FLEET_ALERTS, 'd1', () =>
      Promise.resolve({ sent: 2, errors: 1 }),
    );
    expect(cierres[0]).toMatchObject({
      status: ProcessRunStatus.PARTIAL,
      counters: { sent: 2, errors: 1 },
    });
  });

  it('si la corrida falla registra el error sin datos sensibles y lo vuelve a lanzar', async () => {
    const { recorder, cierres } = armar();
    const falla = new Error('rechazado token=supersecreto');
    await expect(
      recorder.ejecutar(ProcessName.STOCK_RECONCILIATION, null, () =>
        Promise.reject(falla),
      ),
    ).rejects.toBe(falla);
    expect(cierres[0]).toMatchObject({ status: ProcessRunStatus.FAILED });
    expect(cierres[0].error).not.toMatch(/supersecreto/);
  });

  it('si no se puede abrir el registro, el proceso corre igual', async () => {
    const { recorder, cierres } = armar({ insert: true });
    const valor = await recorder.ejecutar(
      ProcessName.IMPORT_CLEANUP,
      null,
      () => Promise.resolve('listo'),
    );
    expect(valor).toBe('listo');
    expect(cierres).toHaveLength(0);
  });

  it('si no se puede cerrar el registro, el proceso devuelve su valor', async () => {
    const { recorder } = armar({ update: true });
    await expect(
      recorder.ejecutar(ProcessName.IMPORT_CLEANUP, null, () =>
        Promise.resolve(7),
      ),
    ).resolves.toBe(7);
  });

  it('si no se puede cerrar el registro de una corrida fallida, sigue saliendo el error original', async () => {
    const { recorder } = armar({ update: true });
    const falla = new Error('original');
    await expect(
      recorder.ejecutar(ProcessName.IMPORT_CLEANUP, null, () =>
        Promise.reject(falla),
      ),
    ).rejects.toBe(falla);
  });

  it('un proceso de alta frecuencia registra una corrida cada tanto, no cada tic', async () => {
    const { recorder, insertados } = armar();
    for (let i = 0; i < 5; i++) {
      await recorder.ejecutar(ProcessName.DISPATCH_TICK, null, () =>
        Promise.resolve(0),
      );
    }
    expect(insertados).toHaveLength(1);
  });

  it('en alta frecuencia un error sí se registra aunque el tic no', async () => {
    const { recorder, insertados, cierres } = armar();
    await recorder.ejecutar(ProcessName.DISPATCH_TICK, null, () =>
      Promise.resolve(0),
    );
    await expect(
      recorder.ejecutar(ProcessName.DISPATCH_TICK, null, () =>
        Promise.reject(new Error('boom')),
      ),
    ).rejects.toThrow('boom');
    expect(insertados).toHaveLength(2);
    expect(cierres[1]).toMatchObject({ status: ProcessRunStatus.FAILED });
  });
});

describe('@ConRegistro', () => {
  class Tarea {
    @ConRegistro(ProcessName.IMPORT_CLEANUP)
    async correr(n: number): Promise<number> {
      return Promise.resolve(n + 1);
    }
  }

  afterEach(() => ProcessRunRecorder.desinstalar());

  it('sin registrador instalado llama al método tal cual', async () => {
    await expect(new Tarea().correr(1)).resolves.toBe(2);
  });

  it('con registrador instalado registra la corrida y conserva argumentos y resultado', async () => {
    const { recorder, insertados } = armar();
    recorder.onModuleInit();
    await expect(new Tarea().correr(1)).resolves.toBe(2);
    expect(insertados[0]).toMatchObject({ process: 'import_cleanup' });
  });
});

describe('señales de la corrida', () => {
  it('una corrida que no hizo nada por no tener el cerrojo queda skipped y sin contadores', async () => {
    const { recorder, cierres } = armar();
    await recorder.ejecutar(ProcessName.COVERAGE_ZONE_EXPIRY, null, () => {
      marcarSaltada();
      return Promise.resolve(undefined);
    });
    expect(cierres[0]).toMatchObject({
      status: ProcessRunStatus.SKIPPED,
      counters: {},
      error: null,
    });
  });

  it('un error atrapado de una parte deja la corrida partial con el último error', async () => {
    const { recorder, cierres } = armar();
    await recorder.ejecutar(ProcessName.REPURCHASE_ANTICIPATE, null, () => {
      registrarErrorAtrapado(new Error('falló d1'));
      registrarErrorAtrapado(new Error('falló d2 token=secreto'));
      return Promise.resolve(3);
    });
    expect(cierres[0]).toMatchObject({
      status: ProcessRunStatus.PARTIAL,
      counters: { processed: 3, errors: 2 },
    });
    expect(String(cierres[0].error)).toContain('falló d2');
    expect(String(cierres[0].error)).not.toContain('secreto');
  });

  it('un error atrapado que cortó toda la corrida la deja failed', async () => {
    const { recorder, cierres } = armar();
    await recorder.ejecutar(ProcessName.DISPATCH_TICK, null, () => {
      registrarErrorAtrapado(new Error('tick roto'), true);
      return Promise.resolve(undefined);
    });
    expect(cierres[0]).toMatchObject({
      status: ProcessRunStatus.FAILED,
      error: 'tick roto',
    });
  });

  it('en alta frecuencia un error fatal atrapado también se registra aunque el tic no', async () => {
    const { recorder, insertados, cierres } = armar();
    await recorder.ejecutar(ProcessName.DISPATCH_TICK, null, () =>
      Promise.resolve(undefined),
    );
    await recorder.ejecutar(ProcessName.DISPATCH_TICK, null, () => {
      registrarErrorAtrapado(new Error('tick roto'), true);
      return Promise.resolve(undefined);
    });
    expect(insertados).toHaveLength(2);
    expect(cierres[1]).toMatchObject({ status: ProcessRunStatus.FAILED });
  });

  it('la corrida adelantada por un webhook se guarda con ese disparo y no gasta el muestreo del cron', async () => {
    const { recorder, insertados } = armar();
    await conDisparo(RunTrigger.WEBHOOK, () =>
      recorder.ejecutar(ProcessName.PAYMENT_INBOX_PROCESS, null, () =>
        Promise.resolve(1),
      ),
    );
    await recorder.ejecutar(ProcessName.PAYMENT_INBOX_PROCESS, null, () =>
      Promise.resolve(1),
    );
    expect(insertados.map((i) => i.trigger)).toEqual([
      RunTrigger.WEBHOOK,
      RunTrigger.CRON,
    ]);
  });

  it('las señales fuera de una corrida registrada no hacen nada', () => {
    expect(() => {
      marcarSaltada();
      registrarErrorAtrapado(new Error('x'), true);
    }).not.toThrow();
  });
});

describe('dos instancias que se turnan el cerrojo (muestreo de alta frecuencia)', () => {
  interface Fila {
    id: string;
    instancia: string;
    startedAt: number;
    status: string;
  }

  /** Una base común para las dos instancias: insert, update y delete por `run_id`. */
  const baseCompartida = () => {
    const filas: Fila[] = [];
    let n = 0;
    const repoDe = (instancia: string) => {
      let modo: 'insert' | 'update' | 'delete' = 'insert';
      let valores: Record<string, unknown> = {};
      const qb: Record<string, jest.Mock> = {
        insert: jest.fn(() => ((modo = 'insert'), qb)),
        values: jest.fn((v: Record<string, unknown>) => ((valores = v), qb)),
        update: jest.fn(() => ((modo = 'update'), qb)),
        set: jest.fn((v: Record<string, unknown>) => ((valores = v), qb)),
        delete: jest.fn(() => ((modo = 'delete'), qb)),
        where: jest.fn((_c: string, p: { runId: string }) => {
          if (modo === 'update') {
            const f = filas.find((x) => x.id === p.runId);
            if (f) f.status = String(valores.status);
          }
          if (modo === 'delete') {
            const i = filas.findIndex((x) => x.id === p.runId);
            if (i >= 0) filas.splice(i, 1);
          }
          return qb;
        }),
        execute: jest.fn(() => {
          if (modo !== 'insert') return Promise.resolve({});
          n += 1;
          filas.push({
            id: `r${n}`,
            instancia,
            startedAt: (valores.startedAt as Date).getTime(),
            status: 'running',
          });
          return Promise.resolve({ identifiers: [{ runId: `r${n}` }] });
        }),
      };
      return {
        createQueryBuilder: () => qb,
      } as unknown as Repository<ProcessRun>;
    };
    return { filas, repoDe };
  };

  afterEach(() => jest.useRealTimers());

  it('el despacho no queda atrasado: siempre hay una corrida válida dentro de su ventana, y no se escribe una salteada por tic', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    const { filas, repoDe } = baseCompartida();
    const a = new ProcessRunRecorder(repoDe('A'));
    const b = new ProcessRunRecorder(repoDe('B'));
    const tic = (r: ProcessRunRecorder, gana: boolean) =>
      r.ejecutar(ProcessName.DISPATCH_TICK, null, () => {
        if (!gana) marcarSaltada();
        return Promise.resolve(gana ? 1 : undefined);
      });

    // 30 minutos de tics cada 15 s; el cerrojo lo gana una instancia distinta en cada tic.
    for (let i = 0; i < 120; i++) {
      await tic(a, i % 2 === 0);
      await tic(b, i % 2 === 1);
      jest.advanceTimersByTime(15_000);
    }

    const validas = filas
      .filter((f) => f.status !== 'skipped')
      .map((f) => f.startedAt);
    expect(validas.length).toBeGreaterThanOrEqual(5);
    const huecos = validas.slice(1).map((t, i) => t - validas[i]);
    // La ventana esperada del despacho es de 5 min (atraso a los 7,5 min).
    expect(Math.max(...huecos)).toBeLessThanOrEqual(5 * 60_000 + 15_000);
    // Las salteadas: a lo sumo una por ventana de 5 min y por instancia.
    expect(
      filas.filter((f) => f.status === 'skipped').length,
    ).toBeLessThanOrEqual(2 * 7);
  });
});
