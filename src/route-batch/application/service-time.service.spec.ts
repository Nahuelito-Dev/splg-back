import { DataSource, Repository } from 'typeorm';
import { ProcessConfigService } from '../../distributor/process-config.service';
import { RouteServiceTimeStat } from '../../order/entities/route-service-time-stat.entity';
import { MUESTRAS_MINIMAS } from '../domain/tiempo-de-atencion';
import { ServiceTimeService, modoDeServicio } from './service-time.service';

const DIST = 'dist-a';
const AHORA = new Date('2026-11-25T06:00:00.000Z');

const minutos = (n: number, m: number) =>
  Array.from({ length: n }, () => ({ minutes: String(m) }));

function armar(
  muestras: Array<{ minutes: string }> = [],
  guardada: Partial<RouteServiceTimeStat> | null = null,
  params: Record<string, number> = { serviceMinutes: 10 },
) {
  const dataSource = { query: jest.fn().mockResolvedValue(muestras) };
  const stats = {
    upsert: jest.fn().mockResolvedValue({}),
    findOneByOrFail: jest.fn().mockResolvedValue({}),
    findOneBy: jest.fn().mockResolvedValue(guardada),
  };
  const processConfig = { obtener: jest.fn().mockResolvedValue(params) };
  const service = new ServiceTimeService(
    dataSource as unknown as DataSource,
    stats as unknown as Repository<RouteServiceTimeStat>,
    processConfig as unknown as ProcessConfigService,
  );
  return { service, dataSource, stats, processConfig };
}

describe('ServiceTimeService', () => {
  describe('calcular', () => {
    it('busca las muestras de la distribuidora de los últimos 30 días', async () => {
      const { service, dataSource } = armar();
      await service.calcular(DIST, AHORA);
      const [sql, args] = dataSource.query.mock.calls[0] as [string, unknown[]];
      // 03:00 del 25/11 en Argentina: los 30 días completos del 26/10 al 24/11.
      expect(args).toEqual([
        DIST,
        new Date('2026-10-26T03:00:00.000Z'),
        new Date('2026-11-25T03:00:00.000Z'),
      ]);
      expect(sql).toContain(`b."distributor_id" = $1`);
      expect(sql).toContain(`s."failed_attempts" = 0`);
      expect(sql).toContain(`s."arrived_at" IS NOT NULL`);
      expect(sql).toContain(`o."status" = 'delivered'`);
    });

    it('con muestras suficientes guarda la mediana y el p90', async () => {
      const { service, stats } = armar(minutos(MUESTRAS_MINIMAS, 8));
      await service.calcular(DIST, AHORA);
      expect(stats.upsert).toHaveBeenCalledWith(
        {
          distributorId: DIST,
          samples: MUESTRAS_MINIMAS,
          medianMin: 8,
          p90Min: 8,
          windowDays: 30,
          computedAt: AHORA,
        },
        ['distributorId'],
      );
    });

    it('con una muestra menos del mínimo guarda la cantidad y deja la mediana en null', async () => {
      const { service, stats } = armar(minutos(MUESTRAS_MINIMAS - 1, 8));
      await service.calcular(DIST, AHORA);
      expect(stats.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          samples: MUESTRAS_MINIMAS - 1,
          medianMin: null,
          p90Min: null,
        }),
        ['distributorId'],
      );
    });

    it('es idempotente: dos corridas con los mismos datos escriben lo mismo, sobre la misma fila', async () => {
      const { service, stats } = armar(minutos(30, 6));
      await service.calcular(DIST, AHORA);
      await service.calcular(DIST, AHORA);
      expect(stats.upsert).toHaveBeenCalledTimes(2);
      expect(stats.upsert).toHaveBeenNthCalledWith(
        2,
        ...(stats.upsert.mock.calls[0] as [unknown, unknown]),
      );
    });
  });

  describe('estado', () => {
    const guardada = {
      medianMin: 7.4,
      p90Min: 12,
      samples: 55,
      windowDays: 30,
      computedAt: AHORA,
    };

    it('sin cálculo todavía: sin sugerido, vigente el fijo', async () => {
      const { service } = armar();
      expect(await service.estado(DIST)).toEqual({
        mode: 'fixed',
        fixedMinutes: 10,
        suggestedMinutes: null,
        p90Minutes: null,
        effectiveMinutes: 10,
        samples: 0,
        minSamples: MUESTRAS_MINIMAS,
        windowDays: 30,
        computedAt: null,
      });
    });

    it('fixed con muestra: sugerido 7 y vigente 10', async () => {
      const { service } = armar([], guardada);
      expect(await service.estado(DIST)).toMatchObject({
        mode: 'fixed',
        suggestedMinutes: 7,
        p90Minutes: 12,
        effectiveMinutes: 10,
        samples: 55,
        computedAt: AHORA,
      });
    });

    it('learned con muestra: vigente = sugerido', async () => {
      const { service } = armar([], guardada, {
        serviceMinutes: 10,
        serviceMinutesMode: 1,
      });
      expect(await service.estado(DIST)).toMatchObject({
        mode: 'learned',
        suggestedMinutes: 7,
        effectiveMinutes: 7,
      });
    });

    it('learned sin muestra suficiente (mediana null): vigente el fijo', async () => {
      const { service } = armar(
        [],
        { ...guardada, medianMin: null, p90Min: null, samples: 12 },
        { serviceMinutes: 10, serviceMinutesMode: 1 },
      );
      expect(await service.estado(DIST)).toMatchObject({
        mode: 'learned',
        suggestedMinutes: null,
        effectiveMinutes: 10,
        samples: 12,
      });
    });
  });

  describe('medianaAprendida', () => {
    it('la guardada, o null si no hay fila', async () => {
      expect(
        await armar([], { medianMin: 7.4 }).service.medianaAprendida(DIST),
      ).toBe(7.4);
      expect(await armar().service.medianaAprendida(DIST)).toBeNull();
    });
  });

  it('modoDeServicio: 1 es learned; cualquier otro valor, fixed', () => {
    expect(modoDeServicio(1)).toBe('learned');
    expect(modoDeServicio(0)).toBe('fixed');
    expect(modoDeServicio(undefined)).toBe('fixed');
  });
});
