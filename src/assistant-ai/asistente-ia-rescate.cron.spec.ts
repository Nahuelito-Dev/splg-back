import { Logger } from '@nestjs/common';
import {
  dentroDeCorrida,
  nuevaCorrida,
} from '../process-run/process-run.context';
import type { RedisService } from '../redis/redis.service';
import { AsistenteIaRescateCron } from './asistente-ia-rescate.cron';
import type { AsistenteIaService } from './asistente-ia.service';

function armar(
  lock: boolean,
  rescatar: () => Promise<number> = () => Promise.resolve(2),
) {
  const redis = {
    withLock: jest.fn(
      async (_k: string, _t: number, fn: () => Promise<unknown>) =>
        lock ? { obtenido: true, valor: await fn() } : { obtenido: false },
    ),
  };
  const asistente = { rescatarSinAtender: jest.fn(rescatar) };
  return {
    cron: new AsistenteIaRescateCron(
      redis as unknown as RedisService,
      asistente as unknown as AsistenteIaService,
    ),
    redis,
    asistente,
  };
}

const corrida = async (fn: () => Promise<unknown>) => {
  const estado = nuevaCorrida();
  const valor = await dentroDeCorrida(estado, fn);
  return { estado, valor };
};

describe('AsistenteIaRescateCron (cada minuto, una sola instancia)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('con el cerrojo, rescata y devuelve cuántos derivó', async () => {
    const { cron, redis, asistente } = armar(true);
    const { estado, valor } = await corrida(() => cron.rescatar());
    expect(valor).toEqual({ handedOff: 2 });
    expect(estado.skipped).toBe(false);
    expect(redis.withLock).toHaveBeenCalledWith(
      'cron:assistant-ai-sweep',
      55_000,
      expect.any(Function),
    );
    expect(asistente.rescatarSinAtender).toHaveBeenCalledWith(expect.any(Date));
  });

  it('sin nada que rescatar, igual registra la corrida', async () => {
    const { cron } = armar(true, () => Promise.resolve(0));
    const { valor } = await corrida(() => cron.rescatar());
    expect(valor).toEqual({ handedOff: 0 });
  });

  it('sin el cerrojo (otra instancia), la corrida queda salteada y no rescata', async () => {
    const { cron, asistente } = armar(false);
    const { estado, valor } = await corrida(() => cron.rescatar());
    expect(estado.skipped).toBe(true);
    expect(valor).toBeUndefined();
    expect(asistente.rescatarSinAtender).not.toHaveBeenCalled();
  });

  it('si falla, lo registra como error de la corrida y no tira', async () => {
    const { cron } = armar(true, () => Promise.reject(new Error('base caída')));
    const { estado, valor } = await corrida(() => cron.rescatar());
    expect(valor).toBeUndefined();
    expect(estado.errors).toBeGreaterThan(0);
  });
});
