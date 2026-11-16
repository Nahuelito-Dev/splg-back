import type { DataSource, EntityManager } from 'typeorm';
import { DistributorStatus } from '../../distributor/entities/distributor.entity';
import {
  SupportEndReason,
  SupportSessionStatus,
} from '../domain/support-session.enums';
import { SupportSession } from '../entities/support-session.entity';
import type { SupportSessionCache } from './support-session.cache';
import { SupportSessionResolver } from './support-session.resolver';
import type { SupportEndedNotice } from './support-ended.notice';

const ID = '11111111-1111-4111-8111-111111111111';
const AHORA = new Date('2026-11-13T12:00:00Z');
const VENCE = new Date('2026-11-13T13:00:00Z');

function fila(cambios: Record<string, unknown> = {}) {
  return {
    id: ID,
    requested_by: 'super-1',
    distributor_id: 'empresa-a',
    status: SupportSessionStatus.ACTIVE,
    scope: ['files'],
    expires_at: VENCE,
    vigente: true,
    distributor_status: DistributorStatus.ACTIVE,
    distributor_baja: false,
    ...cambios,
  };
}

/** El código del error HTTP que lanzó la promesa. */
async function codigo(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolvió';
  } catch (error) {
    return (error as { response: { code: string } }).response.code;
  }
}

describe('SupportSessionResolver', () => {
  let query: jest.Mock;
  let guardada: SupportSession | null;
  let cache: { leer: jest.Mock; guardar: jest.Mock; olvidar: jest.Mock };
  let fin: { avisar: jest.Mock };
  let resolver: SupportSessionResolver;

  beforeEach(() => {
    query = jest.fn();
    guardada = null;
    const manager = {
      getRepository: () => ({
        findOne: jest.fn(() =>
          Promise.resolve(
            Object.assign(new SupportSession(), {
              supportSessionId: ID,
              status: SupportSessionStatus.ACTIVE,
            }),
          ),
        ),
        save: jest.fn((s: SupportSession) => {
          guardada = s;
          return Promise.resolve(s);
        }),
      }),
    } as unknown as EntityManager;
    const dataSource = {
      query,
      transaction: (fn: (m: EntityManager) => Promise<unknown>) => fn(manager),
    } as unknown as DataSource;
    cache = {
      leer: jest.fn().mockResolvedValue(null),
      guardar: jest.fn().mockResolvedValue(undefined),
      olvidar: jest.fn().mockResolvedValue(undefined),
    };
    fin = { avisar: jest.fn() };
    resolver = new SupportSessionResolver(
      dataSource,
      cache as unknown as SupportSessionCache,
      fin as unknown as SupportEndedNotice,
    );
  });

  it('activa, propia y en plazo: devuelve la sesión y la guarda en la caché', async () => {
    query.mockResolvedValue([fila()]);

    await expect(resolver.vigente(ID, 'super-1', AHORA)).resolves.toEqual({
      id: ID,
      distributorId: 'empresa-a',
      scope: ['files'],
      expiresAt: VENCE,
    });
    expect(cache.guardar).toHaveBeenCalledWith(
      expect.objectContaining({ id: ID, requestedBy: 'super-1' }),
      AHORA,
    );
  });

  it('un id mal formado es 404 sin ir a la base', async () => {
    expect(await codigo(resolver.vigente('no-es-uuid', 'super-1'))).toBe(
      'SUPPORT_SESSION_NOT_FOUND',
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('inexistente: 404', async () => {
    query.mockResolvedValue([]);
    expect(await codigo(resolver.vigente(ID, 'super-1', AHORA))).toBe(
      'SUPPORT_SESSION_NOT_FOUND',
    );
  });

  it('de otro administrador general: 404 (no se revela que existe)', async () => {
    query.mockResolvedValue([fila()]);
    expect(await codigo(resolver.vigente(ID, 'super-2', AHORA))).toBe(
      'SUPPORT_SESSION_NOT_FOUND',
    );
  });

  it.each([
    SupportSessionStatus.PENDING,
    SupportSessionStatus.ENDED,
    SupportSessionStatus.REVOKED,
    SupportSessionStatus.EXPIRED,
    SupportSessionStatus.REJECTED,
    SupportSessionStatus.CANCELLED,
    SupportSessionStatus.EXPIRED_REQUEST,
  ])('%s: 403 terminada', async (status) => {
    query.mockResolvedValue([fila({ status })]);
    expect(await codigo(resolver.vigente(ID, 'super-1', AHORA))).toBe(
      'SUPPORT_SESSION_ENDED',
    );
    expect(cache.guardar).not.toHaveBeenCalled();
  });

  it('activa pero vencida según el reloj de la base: 403 terminada', async () => {
    query.mockResolvedValue([fila({ vigente: false })]);
    expect(await codigo(resolver.vigente(ID, 'super-1', AHORA))).toBe(
      'SUPPORT_SESSION_ENDED',
    );
  });

  it.each([
    ['suspendida', { distributor_status: DistributorStatus.SUSPENDED }],
    ['dada de baja', { distributor_baja: true }],
  ])(
    'empresa %s durante la sesión: la cierra (revocada por la plataforma) y 403',
    async (_n, cambios) => {
      query.mockResolvedValue([fila(cambios)]);

      expect(await codigo(resolver.vigente(ID, 'super-1', AHORA))).toBe(
        'SUPPORT_SESSION_ENDED',
      );
      expect(guardada).toMatchObject({
        status: SupportSessionStatus.REVOKED,
        endReason: SupportEndReason.REVOKED_BY_PLATFORM,
        endedBy: null,
      });
      expect(cache.olvidar).toHaveBeenCalledWith(ID);
      expect(fin.avisar).toHaveBeenCalledWith(
        expect.objectContaining({ supportSessionId: ID, status: 'revoked' }),
      );
    },
  );

  const enCache = {
    id: ID,
    requestedBy: 'super-1',
    distributorId: 'empresa-a',
    scope: [],
    expiresAt: VENCE,
  };

  it('con caché vigente no relee la sesión: sólo mira que la empresa siga disponible', async () => {
    cache.leer.mockResolvedValue(enCache);
    query.mockResolvedValue([{ disponible: true }]);

    await expect(resolver.vigente(ID, 'super-1', AHORA)).resolves.toMatchObject(
      { distributorId: 'empresa-a' },
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect((query.mock.calls as string[][])[0][0]).toContain(
      'FROM "distributor"',
    );
  });

  it('caché caliente y DESPUÉS se suspende la empresa: la cierra y 403', async () => {
    // Primero la sesión anda y queda en la caché...
    query.mockResolvedValueOnce([fila()]);
    await resolver.vigente(ID, 'super-1', AHORA);
    const guardado = (
      cache.guardar.mock.calls as Array<[typeof enCache]>
    )[0][0];
    // ...la empresa se suspende y la request siguiente sale de la caché.
    cache.leer.mockResolvedValue(guardado);
    query.mockResolvedValueOnce([{ disponible: false }]);

    expect(await codigo(resolver.vigente(ID, 'super-1', AHORA))).toBe(
      'SUPPORT_SESSION_ENDED',
    );
    expect(guardada).toMatchObject({
      status: SupportSessionStatus.REVOKED,
      endReason: SupportEndReason.REVOKED_BY_PLATFORM,
    });
    expect(cache.olvidar).toHaveBeenCalledWith(ID);
  });

  it('la caché de otro administrador general también es 404', async () => {
    cache.leer.mockResolvedValue({
      id: ID,
      requestedBy: 'super-1',
      distributorId: 'empresa-a',
      scope: [],
      expiresAt: VENCE,
    });
    expect(await codigo(resolver.vigente(ID, 'super-2', AHORA))).toBe(
      'SUPPORT_SESSION_NOT_FOUND',
    );
  });

  it('una caché que ya pasó el vencimiento no se usa: decide la base', async () => {
    cache.leer.mockResolvedValue({
      id: ID,
      requestedBy: 'super-1',
      distributorId: 'empresa-a',
      scope: [],
      expiresAt: AHORA,
    });
    query.mockResolvedValue([fila({ vigente: false })]);

    expect(await codigo(resolver.vigente(ID, 'super-1', AHORA))).toBe(
      'SUPPORT_SESSION_ENDED',
    );
    expect(query).toHaveBeenCalled();
  });
});
