import type { DataSource, EntityManager } from 'typeorm';
import type { RedisService } from '../../redis/redis.service';
import {
  SupportEndReason,
  SupportSessionStatus as S,
} from '../domain/support-session.enums';
import { SupportSession } from '../entities/support-session.entity';
import type { SupportSessionCache } from './support-session.cache';
import { SupportSessionExpiryCron } from './support-session-expiry.cron';
import type { SupportEndedNotice } from './support-ended.notice';

const PASADO = new Date(Date.now() - 60_000);
const FUTURO = new Date(Date.now() + 60 * 60_000);

describe('SupportSessionExpiryCron', () => {
  let enLaBase: Map<string, SupportSession>;
  let guardadas: SupportSession[];
  let candidatas: Array<{ id: string; status: S }>;
  let cache: { olvidar: jest.Mock };
  let redis: { withLock: jest.Mock };
  let fin: { avisar: jest.Mock };
  let cron: SupportSessionExpiryCron;

  beforeEach(() => {
    enLaBase = new Map();
    guardadas = [];
    candidatas = [];
    const manager = {
      getRepository: () => ({
        findOne: ({ where }: { where: { supportSessionId: string } }) =>
          Promise.resolve(enLaBase.get(where.supportSessionId) ?? null),
        save: (s: SupportSession) => {
          guardadas.push({ ...s } as SupportSession);
          return Promise.resolve(s);
        },
      }),
    } as unknown as EntityManager;
    const dataSource = {
      query: jest.fn(() => Promise.resolve(candidatas)),
      transaction: (fn: (m: EntityManager) => Promise<unknown>) => fn(manager),
    } as unknown as DataSource;
    cache = { olvidar: jest.fn().mockResolvedValue(undefined) };
    redis = {
      withLock: jest.fn(
        async (_k: string, _t: number, fn: () => Promise<unknown>) => ({
          obtenido: true,
          valor: await fn(),
        }),
      ),
    };
    fin = { avisar: jest.fn() };
    cron = new SupportSessionExpiryCron(
      dataSource,
      redis as unknown as RedisService,
      cache as unknown as SupportSessionCache,
      fin as unknown as SupportEndedNotice,
    );
  });

  function sembrar(id: string, datos: Partial<SupportSession>): void {
    enLaBase.set(
      id,
      Object.assign(new SupportSession(), { supportSessionId: id, ...datos }),
    );
    candidatas.push({ id, status: datos.status as S });
  }

  it('vence las activas pasadas y caduca los pedidos viejos, por la máquina', async () => {
    sembrar('activa-vencida', { status: S.ACTIVE, expiresAt: PASADO });
    sembrar('pedido-viejo', { status: S.PENDING, requestExpiresAt: PASADO });

    await expect(cron.vencer()).resolves.toEqual({
      expired: 1,
      expiredRequests: 1,
    });
    expect(guardadas).toEqual([
      expect.objectContaining({
        supportSessionId: 'activa-vencida',
        status: S.EXPIRED,
        endReason: SupportEndReason.EXPIRED,
        endedAt: PASADO,
        endedBy: null,
      }),
      expect.objectContaining({
        supportSessionId: 'pedido-viejo',
        status: S.EXPIRED_REQUEST,
      }),
    ]);
    expect(cache.olvidar).toHaveBeenCalledWith('activa-vencida');
    // Sólo la activa saca al super admin del modo (el pedido no lo había metido).
    expect(fin.avisar.mock.calls).toEqual([
      [expect.objectContaining({ supportSessionId: 'activa-vencida' })],
    ]);
  });

  it('si al bloquearla ya la cambió otro (aprobada, revocada o con plazo), no la toca', async () => {
    sembrar('ya-revocada', { status: S.REVOKED, expiresAt: PASADO });
    sembrar('todavia-vigente', { status: S.ACTIVE, expiresAt: FUTURO });
    sembrar('aprobada-justo', {
      status: S.ACTIVE,
      requestExpiresAt: PASADO,
      expiresAt: FUTURO,
    });

    await expect(cron.barrer()).resolves.toEqual({
      expired: 0,
      expiredRequests: 0,
    });
    expect(guardadas).toEqual([]);
    expect(cache.olvidar).not.toHaveBeenCalled();
  });

  it('con otra instancia corriendo se saltea', async () => {
    redis.withLock.mockResolvedValue({ obtenido: false });
    await expect(cron.vencer()).resolves.toBeUndefined();
  });

  it('una falla se registra y no se propaga', async () => {
    redis.withLock.mockRejectedValue(new Error('redis caído'));
    await expect(cron.vencer()).resolves.toBeUndefined();
  });
});
