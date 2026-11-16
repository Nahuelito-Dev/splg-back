import type { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import type { NotificarAdminEvent } from '../common/events/notificar-admin.event';
import type { RedisService } from '../redis/redis.service';
import { ProcessName, ProcessRunStatus } from './domain/process-catalog';
import { ProcessRun } from './entities/process-run.entity';
import {
  nuevaCorrida,
  registrarElementoBien,
  registrarFallaDeElemento,
} from './process-run.context';
import { ProcessRunRecorder } from './process-run.recorder';
import { RachasDeFallas } from './rachas-de-fallas';

const AHORA = new Date('2026-11-15T15:00:00Z');

function armar(o: { redisCaido?: boolean } = {}) {
  const claves = new Map<string, string>();
  const redis = {
    get: jest.fn((k: string) =>
      o.redisCaido
        ? Promise.reject(new Error('redis caído'))
        : Promise.resolve(claves.get(k) ?? null),
    ),
    setex: jest.fn((k: string, _ttl: number, v: string) => {
      claves.set(k, v);
      return Promise.resolve();
    }),
    del: jest.fn((k: string) => {
      claves.delete(k);
      return Promise.resolve();
    }),
  };
  const avisos: NotificarAdminEvent[] = [];
  const events = {
    emit: jest.fn((_n: string, e: NotificarAdminEvent) => {
      avisos.push(e);
      return true;
    }),
  };
  const rachas = new RachasDeFallas(
    redis as unknown as RedisService,
    events as unknown as EventEmitter2,
  );
  /** Una corrida con lo que falló y lo que salió bien. */
  const corrida = (fallan: string[], bien: string[] = []) => {
    const estado = nuevaCorrida();
    for (const e of fallan) estado.elementos.fallidos.set(e, `rompió ${e}`);
    for (const e of bien) estado.elementos.bien.add(e);
    return rachas.seguir(ProcessName.SUPPORT_HOUSEKEEPING, null, estado, AHORA);
  };
  return { rachas, redis, claves, avisos, corrida };
}

describe('RachasDeFallas', () => {
  it('un elemento que falla 3 corridas seguidas avisa una sola vez a la plataforma; los demás no', async () => {
    const t = armar();
    expect(await t.corrida(['ticket:a'], ['ticket:b'])).toEqual({
      persistentes: 0,
      avisados: 0,
    });
    expect(await t.corrida(['ticket:a'], ['ticket:b'])).toEqual({
      persistentes: 0,
      avisados: 0,
    });
    expect(t.avisos).toEqual([]);
    expect(await t.corrida(['ticket:a'], ['ticket:b'])).toEqual({
      persistentes: 1,
      avisados: 1,
    });
    // La cuarta y la quinta siguen contando como persistente, sin otro aviso.
    expect(await t.corrida(['ticket:a'])).toEqual({
      persistentes: 1,
      avisados: 0,
    });
    await t.corrida(['ticket:a']);
    expect(t.avisos).toHaveLength(1);
    expect(t.avisos[0]).toMatchObject({
      distributorId: null,
      kind: 'process_run_alert',
      link: { entity: 'process-run', id: ProcessName.SUPPORT_HOUSEKEEPING },
    });
    expect(t.avisos[0].body).toContain('ticket:a');
    expect(t.avisos[0].body).toContain('3 corridas seguidas');
    expect(t.avisos[0].body).toContain('rompió ticket:a');
    expect(t.avisos[0].body).not.toMatch(/m[oó]dulo|plan\b/i);
  });

  it('salir bien corta la racha: dos fallas, una bien y dos fallas no avisan', async () => {
    const t = armar();
    await t.corrida(['chat:x']);
    await t.corrida(['chat:x']);
    await t.corrida([], ['chat:x']);
    await t.corrida(['chat:x']);
    expect(await t.corrida(['chat:x'])).toEqual({
      persistentes: 0,
      avisados: 0,
    });
    expect(t.avisos).toEqual([]);
  });

  it('las rachas viven en Redis por proceso (otra instancia sigue la cuenta) y se borran al quedar vacías', async () => {
    const t = armar();
    await t.corrida(['lote:1']);
    expect([...t.claves.keys()]).toEqual([
      'proceso:rachas:support_housekeeping:global',
    ]);
    const otra = new RachasDeFallas(
      t.redis as unknown as RedisService,
      { emit: jest.fn() } as unknown as EventEmitter2,
    );
    const estado = nuevaCorrida();
    estado.elementos.fallidos.set('lote:1', 'x');
    await otra.seguir(ProcessName.SUPPORT_HOUSEKEEPING, null, estado, AHORA);
    expect(JSON.parse(t.claves.values().next().value as string)).toEqual({
      'lote:1': 2,
    });
    await t.corrida([], ['lote:1']);
    expect(t.claves.size).toBe(0);
  });

  it('sin nada que seguir no toca Redis; si Redis falla, la corrida sigue', async () => {
    const t = armar();
    await t.corrida([]);
    expect(t.redis.get).not.toHaveBeenCalled();
    const caido = armar({ redisCaido: true });
    await expect(caido.corrida(['x'])).resolves.toEqual({
      persistentes: 0,
      avisados: 0,
    });
  });
});

describe('ProcessRunRecorder con las rachas instaladas', () => {
  afterEach(() => RachasDeFallas.desinstalar());

  it('la corrida sigue partial por sus errores y suma `persistentFailures` con los que llevan 3 seguidas', async () => {
    const t = armar();
    t.rachas.onModuleInit();
    const cierres: Record<string, unknown>[] = [];
    const qb: Record<string, jest.Mock> = {
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      set: jest.fn((v: Record<string, unknown>): unknown => {
        cierres.push(v);
        return qb;
      }),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
    };
    const recorder = new ProcessRunRecorder({
      createQueryBuilder: () => qb,
    } as unknown as Repository<ProcessRun>);
    const correr = () =>
      recorder.ejecutar(ProcessName.SUPPORT_HOUSEKEEPING, null, () => {
        registrarFallaDeElemento('ticket:a', new Error('fila rota'));
        registrarElementoBien('ticket:b');
        return Promise.resolve({ ticketsClosed: 1 });
      });
    await correr();
    await correr();
    expect(cierres[1]).toMatchObject({
      status: ProcessRunStatus.PARTIAL,
      counters: { ticketsClosed: 1, errors: 1 },
    });
    expect(cierres[1].counters).not.toHaveProperty('persistentFailures');
    await correr();
    expect(cierres[2]).toMatchObject({
      status: ProcessRunStatus.PARTIAL,
      counters: { ticketsClosed: 1, errors: 1, persistentFailures: 1 },
    });
    expect(t.avisos).toHaveLength(1);
  });
});
