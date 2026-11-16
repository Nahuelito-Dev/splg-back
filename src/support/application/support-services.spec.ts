import type { ConfigService } from '@nestjs/config';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { DataSource, EntityManager } from 'typeorm';
import { DistributorStatus } from '../../distributor/entities/distributor.entity';
import type { DistributorService } from '../../distributor/distributor.service';
import {
  SupportEndReason,
  SupportScope,
  SupportSessionKind,
  SupportSessionStatus as S,
} from '../domain/support-session.enums';
import { SupportSession } from '../entities/support-session.entity';
import { CreateSupportSessionDto } from '../presentation/dto/create-support-session.dto';
import { SupportAccessService } from './support-access.service';
import type { SupportSessionCache } from './support-session.cache';
import {
  NOTA_DE_AUTOAPROBACION,
  SupportSessionsService,
} from './support-sessions.service';
import { SupportNotices } from './support-notices';
import type { SupportEndedNotice } from './support-ended.notice';

/** Una base de mentira para los servicios del modo soporte. */
interface BaseFalsa {
  dataSource: DataSource;
  repo: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    findAndCount: jest.Mock;
    find: jest.Mock;
    count: jest.Mock;
  };
  query: jest.Mock;
  /** Lo que se guardó, en orden. */
  guardadas: SupportSession[];
  /** Las sentencias crudas que pasaron por `manager.query`. */
  sentencias: string[];
}

function baseFalsa(): BaseFalsa {
  const guardadas: SupportSession[] = [];
  const sentencias: string[] = [];
  const repo = {
    create: jest.fn((datos: Partial<SupportSession>) =>
      Object.assign(new SupportSession(), datos),
    ),
    save: jest.fn((s: SupportSession) => {
      s.supportSessionId ??= 'nueva-sesion';
      guardadas.push({ ...s } as SupportSession);
      return Promise.resolve(s);
    }),
    findOne: jest.fn(),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  };
  const query = jest.fn((sql: string) => {
    sentencias.push(sql);
    return Promise.resolve([]);
  });
  const manager = {
    getRepository: () => repo,
    query,
  } as unknown as EntityManager;
  const dataSource = {
    transaction: (fn: (m: EntityManager) => Promise<unknown>) => fn(manager),
    getRepository: () => repo,
    query,
  } as unknown as DataSource;
  return { dataSource, repo, query, guardadas, sentencias };
}

/** Las sentencias crudas con sus parámetros, en orden. */
function llamadas(base: BaseFalsa): Array<[string, unknown[]]> {
  return base.query.mock.calls as Array<[string, unknown[]]>;
}

function sesion(datos: Partial<SupportSession>): SupportSession {
  return Object.assign(new SupportSession(), {
    supportSessionId: 'sesion-1',
    distributorId: 'empresa-a',
    requestedBy: 'super-1',
    scope: [],
    requestedMinutes: 60,
    requestExpiresAt: null,
    expiresAt: null,
    ...datos,
  });
}

/** El `code` (o el status) del error HTTP o de dominio con que falló la promesa. */
async function falla(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolvió';
  } catch (error) {
    const e = error as {
      code?: string;
      response?: { code?: string; statusCode?: number };
      status?: number;
    };
    return (
      e.response?.code ??
      e.code ??
      String(e.response?.statusCode ?? e.status ?? (error as Error).name)
    );
  }
}

const AHORA = new Date('2026-11-13T12:00:00Z');
const MOTIVO = 'El tablero de despacho no muestra los pedidos de hoy';

function empresa(datos: Record<string, unknown> = {}) {
  return {
    distributorId: 'empresa-a',
    name: 'Empresa A',
    status: DistributorStatus.ACTIVE,
    supportEmergencyAllowed: true,
    supportAutoApprove: false,
    ...datos,
  };
}

function pedido(datos: Partial<CreateSupportSessionDto> = {}) {
  return Object.assign(new CreateSupportSessionDto(), {
    distributorId: 'empresa-a',
    reason: MOTIVO,
    minutes: 60,
    scope: [],
    emergency: false,
    ...datos,
  });
}

describe('SupportSessionsService', () => {
  let base: BaseFalsa;
  let distribuidoras: { findOne: jest.Mock };
  let cache: { olvidar: jest.Mock };
  let eventos: { emit: jest.Mock };
  let fin: { avisar: jest.Mock };
  let service: SupportSessionsService;

  beforeEach(() => {
    base = baseFalsa();
    distribuidoras = { findOne: jest.fn().mockResolvedValue(empresa()) };
    cache = { olvidar: jest.fn().mockResolvedValue(undefined) };
    eventos = { emit: jest.fn() };
    const avisos = new SupportNotices(
      eventos as unknown as EventEmitter2,
      { get: () => ({ name: 'Plataforma X' }) } as unknown as ConfigService,
    );
    fin = { avisar: jest.fn() };
    service = new SupportSessionsService(
      base.dataSource,
      distribuidoras as unknown as DistributorService,
      cache as unknown as SupportSessionCache,
      avisos,
      fin as unknown as SupportEndedNotice,
    );
    base.repo.findOne.mockImplementation(() =>
      Promise.resolve(base.guardadas.at(-1) ?? null),
    );
  });

  describe('pedir', () => {
    it('consentido: pendiente, con 24 h para responder y aviso a la empresa', async () => {
      await service.pedir('super-1', pedido(), AHORA);

      expect(base.guardadas[0]).toMatchObject({
        kind: SupportSessionKind.CONSENTED,
        status: S.PENDING,
        requestedBy: 'super-1',
        requestExpiresAt: new Date('2026-11-14T12:00:00Z'),
        startedAt: null,
        expiresAt: null,
      });
      expect(eventos.emit).toHaveBeenCalledWith(
        'admin.notificar',
        expect.objectContaining({
          distributorId: 'empresa-a',
          kind: 'support_access_requested',
          title: 'El soporte de Plataforma X pidió acceso de lectura',
          email: true,
        }),
      );
    });

    it('emergencia: activa al instante, sin decisión, y aviso de emergencia', async () => {
      await service.pedir(
        'super-1',
        pedido({ emergency: true, minutes: 30 }),
        AHORA,
      );

      expect(base.guardadas[0]).toMatchObject({
        kind: SupportSessionKind.EMERGENCY,
        status: S.ACTIVE,
        decidedBy: null,
        decidedAt: null,
        requestExpiresAt: null,
        startedAt: AHORA,
        expiresAt: new Date('2026-11-13T12:30:00Z'),
      });
      expect(eventos.emit).toHaveBeenCalledWith(
        'admin.notificar',
        expect.objectContaining({ kind: 'support_emergency_opened' }),
      );
    });

    it('autoaprobación de la empresa: activa al instante, con la nota y aviso', async () => {
      distribuidoras.findOne.mockResolvedValue(
        empresa({ supportAutoApprove: true }),
      );
      await service.pedir('super-1', pedido({ minutes: 15 }), AHORA);

      expect(base.guardadas[0]).toMatchObject({
        kind: SupportSessionKind.CONSENTED,
        status: S.ACTIVE,
        decidedAt: AHORA,
        decisionNote: NOTA_DE_AUTOAPROBACION,
        expiresAt: new Date('2026-11-13T12:15:00Z'),
      });
      expect(eventos.emit).toHaveBeenCalledWith(
        'admin.notificar',
        expect.objectContaining({ kind: 'support_access_auto_approved' }),
      );
    });

    it('emergencia que la empresa no permite: 403 y nada guardado', async () => {
      distribuidoras.findOne.mockResolvedValue(
        empresa({ supportEmergencyAllowed: false }),
      );
      expect(
        await falla(service.pedir('super-1', pedido({ emergency: true }))),
      ).toBe('SUPPORT_EMERGENCY_DISABLED');
      expect(base.guardadas).toEqual([]);
    });

    it('la emergencia permitida no depende de la autoaprobación', async () => {
      distribuidoras.findOne.mockResolvedValue(
        empresa({ supportEmergencyAllowed: false, supportAutoApprove: true }),
      );
      expect(
        await falla(service.pedir('super-1', pedido({ emergency: true }))),
      ).toBe('SUPPORT_EMERGENCY_DISABLED');
    });

    it('emergencia de más de 60 minutos: 400', async () => {
      expect(
        await falla(
          service.pedir('super-1', pedido({ emergency: true, minutes: 120 })),
        ),
      ).toBe('DuracionInvalidaError');
    });

    it('empresa suspendida: 409', async () => {
      distribuidoras.findOne.mockResolvedValue(
        empresa({ status: DistributorStatus.SUSPENDED }),
      );
      expect(await falla(service.pedir('super-1', pedido()))).toBe(
        'SUPPORT_COMPANY_SUSPENDED',
      );
    });

    it('con una sesión activa: 409 ya tiene una activa', async () => {
      base.query.mockResolvedValueOnce([{ status: S.ACTIVE }]);
      expect(await falla(service.pedir('super-1', pedido()))).toBe(
        'SUPPORT_SESSION_ALREADY_ACTIVE',
      );
    });

    it('con un pedido pendiente para la misma empresa: 409', async () => {
      base.query.mockResolvedValueOnce([{ status: S.PENDING }]);
      expect(await falla(service.pedir('super-1', pedido()))).toBe(
        'SUPPORT_REQUEST_ALREADY_PENDING',
      );
    });

    it('dos pedidos a la vez: el único de la base se traduce al mismo 409', async () => {
      base.repo.save.mockRejectedValueOnce({
        code: '23505',
        constraint: 'UQ_support_session_activa',
      });
      expect(await falla(service.pedir('super-1', pedido()))).toBe(
        'SUPPORT_SESSION_ALREADY_ACTIVE',
      );
      base.repo.save.mockRejectedValueOnce({
        driverError: {
          code: '23505',
          constraint: 'UQ_support_session_pendiente',
        },
      });
      expect(await falla(service.pedir('super-1', pedido()))).toBe(
        'SUPPORT_REQUEST_ALREADY_PENDING',
      );
    });

    it('el alcance repetido se guarda una sola vez', async () => {
      await service.pedir(
        'super-1',
        pedido({ scope: [SupportScope.FILES, SupportScope.FILES] }),
        AHORA,
      );
      expect(base.guardadas[0].scope).toEqual([SupportScope.FILES]);
    });
  });

  describe('terminar', () => {
    const activa = () =>
      sesion({
        status: S.ACTIVE,
        startedAt: AHORA,
        expiresAt: new Date('2026-11-13T13:00:00Z'),
      });

    it('la propia activa: finalizada por salida, y se olvida de la caché', async () => {
      base.repo.findOne.mockResolvedValue(activa());
      await service.terminar('super-1', 'sesion-1', {}, AHORA);
      expect(base.guardadas[0]).toMatchObject({
        status: S.ENDED,
        endReason: SupportEndReason.EXIT,
        endedBy: 'super-1',
        endedAt: AHORA,
      });
      expect(cache.olvidar).toHaveBeenCalledWith('sesion-1');
      expect(fin.avisar).toHaveBeenCalledWith(
        expect.objectContaining({ status: S.ENDED }),
      );
    });

    it('la propia pendiente: retirada', async () => {
      base.repo.findOne.mockResolvedValue(sesion({ status: S.PENDING }));
      await service.terminar('super-1', 'sesion-1', {}, AHORA);
      expect(base.guardadas[0]).toMatchObject({ status: S.CANCELLED });
    });

    it('la de otro sin motivo: 400', async () => {
      base.repo.findOne.mockResolvedValue(activa());
      expect(await falla(service.terminar('super-2', 'sesion-1', {}))).toBe(
        '400',
      );
      expect(base.guardadas).toEqual([]);
    });

    it('la de otro con motivo: revocada por la plataforma y el motivo a la auditoría', async () => {
      base.repo.findOne.mockResolvedValue(activa());
      await service.terminar(
        'super-2',
        'sesion-1',
        { reason: 'Se pidió por error, la cierro yo' },
        AHORA,
      );
      expect(base.guardadas[0]).toMatchObject({
        status: S.REVOKED,
        endReason: SupportEndReason.REVOKED_BY_PLATFORM,
        endedBy: 'super-2',
      });
      expect(
        base.sentencias.some((q) => q.includes('INSERT INTO "audit"')),
      ).toBe(true);
    });

    it('activa pero ya vencida: queda vencida a la hora de su fin', async () => {
      const vieja = activa();
      base.repo.findOne.mockResolvedValue(vieja);
      await service.terminar(
        'super-1',
        'sesion-1',
        {},
        new Date('2026-11-13T14:00:00Z'),
      );
      expect(base.guardadas[0]).toMatchObject({
        status: S.EXPIRED,
        endReason: SupportEndReason.EXPIRED,
        endedAt: new Date('2026-11-13T13:00:00Z'),
        endedBy: null,
      });
    });

    it('terminada: 409', async () => {
      base.repo.findOne.mockResolvedValue(sesion({ status: S.ENDED }));
      expect(await falla(service.terminar('super-1', 'sesion-1', {}))).toBe(
        'SUPPORT_SESSION_ALREADY_ENDED',
      );
    });

    it('inexistente: 404', async () => {
      base.repo.findOne.mockResolvedValue(null);
      expect(await falla(service.terminar('super-1', 'x', {}))).toBe('404');
    });
  });

  it('listar: «desde» posterior a «hasta» es 400', async () => {
    expect(
      await falla(
        service.listar({
          limit: 20,
          offset: 0,
          from: '2026-11-14T00:00:00Z',
          to: '2026-11-13T00:00:00Z',
        }),
      ),
    ).toBe('400');
  });

  describe('lecturas', () => {
    it('actual: la activa o el pendiente en plazo; si hay, su ficha', async () => {
      base.query.mockResolvedValueOnce([{ id: 'sesion-7' }]);
      base.repo.findOne.mockResolvedValue(
        sesion({ supportSessionId: 'sesion-7' }),
      );
      const actual = await service.actual('super-1');
      expect(actual?.supportSessionId).toBe('sesion-7');
      const [sql, params] = llamadas(base)[0];
      expect(sql).toContain(`"status" = 'active' AND "expires_at" > now()`);
      expect(sql).toContain(
        `"status" = 'pending' AND "request_expires_at" > now()`,
      );
      expect(params).toEqual(['super-1']);
    });

    it('actual: sin ninguna, null y no busca la ficha', async () => {
      expect(await service.actual('super-1')).toBeNull();
      expect(base.repo.findOne).not.toHaveBeenCalled();
    });

    it('listar: sin filtros no pone condiciones y pagina', async () => {
      base.repo.findAndCount.mockResolvedValue([[sesion({})], 1]);
      const r = await service.listar({ limit: 5, offset: 10 });
      expect(r.total).toBe(1);
      expect(base.repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: {}, take: 5, skip: 10 }),
      );
    });

    it('listar: estado, empresa, quién pidió y el rango de fechas', async () => {
      await service.listar({
        limit: 20,
        offset: 0,
        status: S.ACTIVE,
        distributorId: 'empresa-a',
        requestedBy: 'super-1',
        from: '2026-11-01T00:00:00Z',
        to: '2026-11-13T00:00:00Z',
      });
      const where = (
        base.repo.findAndCount.mock.calls[0] as [
          { where: Record<string, unknown> },
        ]
      )[0].where;
      expect(where).toMatchObject({
        status: S.ACTIVE,
        distributorId: 'empresa-a',
        requestedBy: 'super-1',
      });
      expect(where.createdAt).toMatchObject({
        _type: 'between',
        _value: [
          new Date('2026-11-01T00:00:00Z'),
          new Date('2026-11-13T00:00:00Z'),
        ],
      });
    });

    it('listar: sólo «desde» es desde esa fecha; sólo «hasta», hasta esa', async () => {
      await service.listar({
        limit: 20,
        offset: 0,
        from: '2026-11-01T00:00:00Z',
      });
      await service.listar({
        limit: 20,
        offset: 0,
        to: '2026-11-13T00:00:00Z',
      });
      const [desde, hasta] = (
        base.repo.findAndCount.mock.calls as Array<
          [{ where: { createdAt: { _type: string; _value: Date } } }]
        >
      ).map(([o]) => o.where.createdAt);
      expect(desde).toMatchObject({
        _type: 'moreThanOrEqual',
        _value: new Date('2026-11-01T00:00:00Z'),
      });
      expect(hasta).toMatchObject({
        _type: 'lessThanOrEqual',
        _value: new Date('2026-11-13T00:00:00Z'),
      });
    });

    it('accesos: primero la ficha (de la empresa si viene) y después la página', async () => {
      base.repo.findOne.mockResolvedValue(sesion({}));
      base.repo.findAndCount.mockResolvedValue([[], 0]);
      const r = await service.accesos(
        'sesion-1',
        { limit: 10, offset: 0 },
        'empresa-a',
      );
      expect(r).toEqual({ items: [], total: 0 });
      expect(base.repo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { supportSessionId: 'sesion-1', distributorId: 'empresa-a' },
        }),
      );
      expect(base.repo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { supportSessionId: 'sesion-1' },
          take: 10,
          skip: 0,
        }),
      );
    });

    it('accesos de una sesión de otra empresa: 404 sin leer accesos', async () => {
      base.repo.findOne.mockResolvedValue(null);
      expect(
        await falla(
          service.accesos('sesion-1', { limit: 10, offset: 0 }, 'empresa-b'),
        ),
      ).toBe('404');
      expect(base.repo.findAndCount).not.toHaveBeenCalled();
    });
  });

  it('ficha con empresa: busca sólo en esa empresa', async () => {
    base.repo.findOne.mockResolvedValue(null);
    expect(await falla(service.ficha('sesion-1', 'empresa-b'))).toBe('404');
    expect(base.repo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { supportSessionId: 'sesion-1', distributorId: 'empresa-b' },
      }),
    );
  });
});

describe('SupportAccessService', () => {
  let base: BaseFalsa;
  let cache: { olvidar: jest.Mock };
  let fin: { avisar: jest.Mock };
  let distribuidoras: {
    politicaDeSoporte: jest.Mock;
    actualizarPoliticaDeSoporte: jest.Mock;
  };
  let service: SupportAccessService;
  const pendiente = () =>
    sesion({
      status: S.PENDING,
      requestedMinutes: 60,
      scope: [SupportScope.PERSONAL_DATA, SupportScope.FILES],
      requestExpiresAt: new Date('2026-11-14T12:00:00Z'),
    });

  beforeEach(() => {
    base = baseFalsa();
    cache = { olvidar: jest.fn().mockResolvedValue(undefined) };
    const sesiones = {
      ficha: jest.fn((id: string) =>
        Promise.resolve(sesion({ supportSessionId: id })),
      ),
    } as unknown as SupportSessionsService;
    fin = { avisar: jest.fn() };
    distribuidoras = {
      politicaDeSoporte: jest.fn(),
      actualizarPoliticaDeSoporte: jest.fn(),
    };
    service = new SupportAccessService(
      base.dataSource,
      sesiones,
      distribuidoras as unknown as DistributorService,
      cache as unknown as SupportSessionCache,
      fin as unknown as SupportEndedNotice,
    );
  });

  it('política: la lee y la actualiza en la empresa indicada', async () => {
    const politica = { emergencyAllowed: false, autoApprove: true };
    distribuidoras.politicaDeSoporte.mockResolvedValue(politica);
    distribuidoras.actualizarPoliticaDeSoporte.mockResolvedValue(politica);
    expect(await service.politica('empresa-a')).toEqual(politica);
    expect(distribuidoras.politicaDeSoporte).toHaveBeenCalledWith('empresa-a');
    expect(
      await service.actualizarPolitica('empresa-a', { autoApprove: true }),
    ).toEqual(politica);
    expect(distribuidoras.actualizarPoliticaDeSoporte).toHaveBeenCalledWith(
      'empresa-a',
      { autoApprove: true },
    );
  });

  it('listar: la página la eligen los ids (pendientes primero) y conserva ese orden', async () => {
    base.query.mockResolvedValueOnce([{ id: 'p1' }, { id: 'a1' }]);
    base.repo.count.mockResolvedValueOnce(7);
    base.repo.find.mockResolvedValueOnce([
      sesion({ supportSessionId: 'a1', status: S.ACTIVE }),
      sesion({ supportSessionId: 'p1', status: S.PENDING }),
    ]);
    const r = await service.listar('empresa-a', {
      limit: 2,
      offset: 4,
      status: undefined,
    });
    expect({
      ids: r.items.map((i) => i.supportSessionId),
      total: r.total,
      sql: llamadas(base)[0][0].replace(/\s+/g, ' '),
      parametros: llamadas(base)[0][1],
    }).toEqual({
      ids: ['p1', 'a1'],
      total: 7,
      sql: expect.stringContaining(
        `ORDER BY ("status" = 'pending') DESC, "created_at" DESC`,
      ) as unknown,
      parametros: ['empresa-a', 2, 4],
    });
  });

  it('listar: con estado lo filtra; sin filas no carga nada', async () => {
    const r = await service.listar('empresa-a', {
      limit: 20,
      offset: 0,
      status: S.PENDING,
    });
    expect({
      r,
      parametros: llamadas(base)[0][1],
      cargo: base.repo.find.mock.calls.length,
      conteo: (base.repo.count.mock.calls as unknown[][])[0][0],
    }).toEqual({
      r: { items: [], total: 0 },
      parametros: ['empresa-a', 20, 0, 'pending'],
      cargo: 0,
      conteo: { where: { distributorId: 'empresa-a', status: 'pending' } },
    });
  });

  it('aprobar: activa desde ahora, con lo aprobado y quién aprobó', async () => {
    base.repo.findOne.mockResolvedValue(pendiente());
    await service.aprobar(
      'empresa-a',
      'admin-1',
      'sesion-1',
      { minutes: 30, scope: [SupportScope.FILES], note: 'Ok' },
      AHORA,
    );
    expect(base.repo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { supportSessionId: 'sesion-1', distributorId: 'empresa-a' },
        lock: { mode: 'pessimistic_write' },
      }),
    );
    expect(base.guardadas[0]).toMatchObject({
      status: S.ACTIVE,
      decidedBy: 'admin-1',
      decidedAt: AHORA,
      decisionNote: 'Ok',
      scope: [SupportScope.FILES],
      startedAt: AHORA,
      expiresAt: new Date('2026-11-13T12:30:00Z'),
    });
  });

  it('aprobar de otra empresa (no la encuentra en la suya): 404', async () => {
    base.repo.findOne.mockResolvedValue(null);
    expect(
      await falla(service.aprobar('empresa-b', 'admin-1', 'sesion-1', {})),
    ).toBe('404');
  });

  it('aprobar más minutos que lo pedido: 400', async () => {
    base.repo.findOne.mockResolvedValue(pendiente());
    expect(
      await falla(
        service.aprobar(
          'empresa-a',
          'admin-1',
          'sesion-1',
          { minutes: 120 },
          AHORA,
        ),
      ),
    ).toBe('SUPPORT_APPROVAL_EXCEEDS_REQUEST');
  });

  it('aprobar una caducada: 409', async () => {
    base.repo.findOne.mockResolvedValue(pendiente());
    expect(
      await falla(
        service.aprobar(
          'empresa-a',
          'admin-1',
          'sesion-1',
          {},
          new Date('2026-11-14T12:00:00Z'),
        ),
      ),
    ).toBe('SUPPORT_REQUEST_EXPIRED');
  });

  it('aprobar una ya aprobada: 409', async () => {
    base.repo.findOne.mockResolvedValue(sesion({ status: S.ACTIVE }));
    expect(
      await falla(
        service.aprobar('empresa-a', 'admin-1', 'sesion-1', {}, AHORA),
      ),
    ).toBe('SUPPORT_SESSION_NOT_PENDING');
  });

  it('aprobar cuando el soporte ya tiene otra activa (único de la base): 409', async () => {
    base.repo.findOne.mockResolvedValue(pendiente());
    base.repo.save.mockRejectedValueOnce({ code: '23505' });
    expect(
      await falla(
        service.aprobar('empresa-a', 'admin-1', 'sesion-1', {}, AHORA),
      ),
    ).toBe('SUPPORT_SESSION_ALREADY_ACTIVE');
  });

  it('rechazar: rechazada con la nota', async () => {
    base.repo.findOne.mockResolvedValue(pendiente());
    await service.rechazar(
      'empresa-a',
      'admin-1',
      'sesion-1',
      { note: 'No' },
      AHORA,
    );
    expect(base.guardadas[0]).toMatchObject({
      status: S.REJECTED,
      decidedBy: 'admin-1',
      decisionNote: 'No',
    });
  });

  it('revocar una activa: revocada por la empresa y fuera de la caché', async () => {
    base.repo.findOne.mockResolvedValue(
      sesion({ status: S.ACTIVE, expiresAt: new Date('2026-11-13T13:00:00Z') }),
    );
    await service.revocar('empresa-a', 'admin-1', 'sesion-1', AHORA);
    expect(base.guardadas[0]).toMatchObject({
      status: S.REVOKED,
      endReason: SupportEndReason.REVOKED_BY_COMPANY,
      endedBy: 'admin-1',
    });
    expect(cache.olvidar).toHaveBeenCalledWith('sesion-1');
    expect(fin.avisar).toHaveBeenCalledWith(
      expect.objectContaining({ status: S.REVOKED, requestedBy: 'super-1' }),
    );
  });

  it('revocar una pendiente: 409 no está activa', async () => {
    base.repo.findOne.mockResolvedValue(pendiente());
    expect(
      await falla(service.revocar('empresa-a', 'admin-1', 'sesion-1')),
    ).toBe('SUPPORT_SESSION_ALREADY_ENDED');
    expect(cache.olvidar).not.toHaveBeenCalled();
  });
});
