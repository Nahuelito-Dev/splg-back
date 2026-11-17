import type { DataSource } from 'typeorm';
import {
  dentroDeCorrida,
  nuevaCorrida,
} from '../../process-run/process-run.context';
import {
  CATALOGO,
  ProcessName,
} from '../../process-run/domain/process-catalog';
import type { RedisService } from '../../redis/redis.service';
import type { AgentesDeLaBandeja } from '../infrastructure/agentes-de-la-bandeja';
import { AsignacionAutomaticaCron } from './asignacion-automatica.cron';
import type { AsignacionAutomaticaService } from './asignacion-automatica.service';
import type { EquipoDeLaBandejaService } from './equipo-de-la-bandeja.service';

const AHORA = new Date('2026-11-17T15:00:00Z');

function armar(redis: Partial<RedisService> = {}) {
  const agentes = {
    empresasConLaFuncion: jest.fn(() =>
      Promise.resolve(['empresa-a', 'empresa-rota', 'empresa-b']),
    ),
  };
  const asignacion = {
    repartir: jest.fn((d: string) =>
      d === 'empresa-rota'
        ? Promise.reject(new Error('se rompió'))
        : Promise.resolve(
            d === 'empresa-a'
              ? [
                  { conversationId: 'c1', userId: 'ana' },
                  { conversationId: 'c2', userId: 'beto' },
                ]
              : [],
          ),
    ),
  };
  const equipo = { avisar: jest.fn(() => Promise.resolve()) };
  const cron = new AsignacionAutomaticaCron(
    { manager: {} } as unknown as DataSource,
    redis as RedisService,
    agentes as unknown as AgentesDeLaBandeja,
    asignacion as unknown as AsignacionAutomaticaService,
    equipo as unknown as EquipoDeLaBandejaService,
  );
  return { cron, asignacion, equipo, agentes };
}

describe('AsignacionAutomaticaCron (8b): la red de seguridad de cada minuto', () => {
  it('está en el catálogo del monitoreo, cada minuto', () => {
    expect(CATALOGO[ProcessName.CHAT_AUTO_ASSIGN].periodSeconds).toBe(60);
  });

  it('reparte cada empresa con la función, refresca el tablero del equipo y una que falla no frena a las demás', async () => {
    const { cron, asignacion, equipo } = armar();
    const corrida = nuevaCorrida();
    const r = await dentroDeCorrida(corrida, () => cron.barrer(AHORA));
    expect(r).toEqual({ companies: 3, assigned: 2 });
    expect(asignacion.repartir.mock.calls).toEqual([
      ['empresa-a', AHORA],
      ['empresa-rota', AHORA],
      ['empresa-b', AHORA],
    ]);
    expect(equipo.avisar).toHaveBeenCalledWith('empresa-a', undefined, AHORA);
    expect(equipo.avisar).toHaveBeenCalledWith('empresa-b', undefined, AHORA);
    expect(corrida).toMatchObject({ errors: 1, fatal: null });
    expect([...corrida.elementos.fallidos.keys()]).toEqual([
      'empresa:empresa-rota',
    ]);
  });

  it('con el cerrojo tomado por otra instancia, la corrida queda saltada', async () => {
    const withLock = jest.fn(() => Promise.resolve({ obtenido: false }));
    const { cron, asignacion } = armar({
      withLock: withLock as unknown as RedisService['withLock'],
    });
    const corrida = nuevaCorrida();
    expect(
      await dentroDeCorrida(corrida, () => cron.repartir()),
    ).toBeUndefined();
    expect(corrida.skipped).toBe(true);
    expect(asignacion.repartir).not.toHaveBeenCalled();
    expect(withLock).toHaveBeenCalledWith(
      'cron:chat-auto-assign',
      50_000,
      expect.any(Function),
    );
  });

  it('con el cerrojo corre el barrido; si Redis falla, error fatal en la corrida', async () => {
    const ok = armar({
      withLock: jest.fn((_k: string, _t: number, fn: () => Promise<unknown>) =>
        fn().then((valor) => ({ obtenido: true, valor })),
      ) as unknown as RedisService['withLock'],
    });
    expect(await ok.cron.repartir()).toEqual({ companies: 3, assigned: 2 });

    const roto = armar({
      withLock: jest.fn(() =>
        Promise.reject(new Error('sin Redis')),
      ) as unknown as RedisService['withLock'],
    });
    const corrida = nuevaCorrida();
    expect(
      await dentroDeCorrida(corrida, () => roto.cron.repartir()),
    ).toBeUndefined();
    expect(corrida.fatal).not.toBeNull();
  });
});
