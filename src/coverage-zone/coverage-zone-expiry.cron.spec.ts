import { Repository } from 'typeorm';
import {
  CoverageZoneExpiryCron,
  EVENTO_SIN_ZONAS_ACTIVAS,
} from './coverage-zone-expiry.cron';
import { CoverageZone } from './entities/coverage-zone.entity';
import { RedisService } from '../redis/redis.service';
import { AdminGateway } from '../gateways/admin.gateway';

const vencida = (id: string, distributor: string) => ({
  coverage_zone_id: id,
  distributor_id: distributor,
  name: `Zona ${id}`,
  valid_until: new Date('2026-10-01T00:00:00Z'),
});

describe('CoverageZoneExpiryCron', () => {
  let cron: CoverageZoneExpiryCron;
  let query: jest.Mock;
  let withLock: jest.Mock;
  let notifyAdmins: jest.Mock;

  /** `UPDATE` devuelve las vencidas; el `SELECT` de "quedan activas" responde según la distribuidora. */
  const baseConZonas = (
    filas: ReturnType<typeof vencida>[],
    quedanActivas: Record<string, boolean> = {},
  ) =>
    query.mockImplementation((sql: string, params?: string[]) => {
      if (sql.includes('UPDATE')) return Promise.resolve([filas, filas.length]);
      if (sql.includes('SELECT 1 FROM "coverage_zone"')) {
        return Promise.resolve(quedanActivas[params?.[0] ?? ''] ? [{}] : []);
      }
      return Promise.resolve([]);
    });

  beforeEach(() => {
    query = jest.fn();
    baseConZonas([]);
    withLock = jest.fn((_k: string, _ttl: number, fn: () => Promise<unknown>) =>
      fn().then((valor) => ({ obtenido: true, valor })),
    );
    notifyAdmins = jest.fn();
    cron = new CoverageZoneExpiryCron(
      {
        manager: {
          transaction: (fn: (m: unknown) => unknown) => fn({ query }),
        },
      } as unknown as Repository<CoverageZone>,
      { withLock } as unknown as RedisService,
      { notifyAdmins } as unknown as AdminGateway,
    );
  });

  it('desactiva sólo las activas, no borradas y con fecha de fin vencida', async () => {
    await cron.barrer();
    const [consulta] = query.mock.calls[0] as [string];
    expect(consulta).toContain('"isActive" = false');
    expect(consulta).toContain('WHERE "isActive" = true');
    expect(consulta).toContain('"deletedAt" IS NULL');
    expect(consulta).toContain('"valid_until" <= now()');
    expect(consulta).not.toContain('area');
    expect(consulta).not.toContain('surcharge');
  });

  it('no asienta la auditoría a mano: la escribe el trigger de la tabla', async () => {
    baseConZonas([vencida('z1', 'd1'), vencida('z2', 'd1')], { d1: true });
    expect(await cron.barrer()).toBe(2);
    const auditorias = query.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO "audit"'),
    );
    expect(auditorias).toHaveLength(0);
  });

  it('si la distribuidora conserva alguna zona activa no avisa', async () => {
    baseConZonas([vencida('z1', 'd1')], { d1: true });
    await cron.barrer();
    expect(notifyAdmins).not.toHaveBeenCalled();
  });

  it('si apagó la última zona activa avisa a los admins de esa distribuidora', async () => {
    baseConZonas([vencida('z1', 'd1'), vencida('z2', 'd2')], { d2: true });
    await cron.barrer();
    expect(notifyAdmins).toHaveBeenCalledTimes(1);
    expect(notifyAdmins).toHaveBeenCalledWith(
      EVENTO_SIN_ZONAS_ACTIVAS,
      expect.objectContaining({ distributorId: 'd1', zoneIds: ['z1'] }),
      'd1',
    );
  });

  it('sin zonas vencidas no hace nada', async () => {
    expect(await cron.barrer()).toBe(0);
    expect(notifyAdmins).not.toHaveBeenCalled();
  });

  it('corre bajo el cerrojo distribuido', async () => {
    await cron.desactivarVencidas();
    expect(withLock).toHaveBeenCalledWith(
      CoverageZoneExpiryCron.CERROJO,
      CoverageZoneExpiryCron.CERROJO_TTL_MS,
      expect.any(Function),
    );
  });

  it('si otra instancia tiene el cerrojo no barre', async () => {
    withLock.mockResolvedValue({ obtenido: false });
    await cron.desactivarVencidas();
    expect(query).not.toHaveBeenCalled();
  });

  it('si el barrido falla no propaga el error', async () => {
    query.mockRejectedValue(new Error('base caída'));
    await expect(cron.desactivarVencidas()).resolves.toBeUndefined();
  });
});
