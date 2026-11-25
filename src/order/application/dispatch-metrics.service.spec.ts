import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DispatchMetricsService } from './dispatch-metrics.service';

const AHORA = new Date('2026-11-17T12:00:00Z');

function servicio(respuestas: unknown[][]) {
  const query = jest.fn();
  for (const r of respuestas) query.mockResolvedValueOnce(r);
  return {
    query,
    svc: new DispatchMetricsService({ query } as unknown as DataSource),
  };
}

describe('DispatchMetricsService', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(AHORA));
  afterEach(() => jest.useRealTimers());

  it('por omisión mira los últimos 30 días', () => {
    const { svc } = servicio([]);
    const { desde, hasta } = svc.periodo(undefined, undefined);
    expect(hasta).toEqual(AHORA);
    expect(hasta.getTime() - desde.getTime()).toBe(30 * 24 * 3600 * 1000);
  });

  it('rechaza fechas inválidas, invertidas o de más de 366 días', () => {
    const { svc } = servicio([]);
    expect(() => svc.periodo('ayer', undefined)).toThrow(BadRequestException);
    expect(() => svc.periodo('2026-11-10', '2026-11-01')).toThrow(
      BadRequestException,
    );
    expect(() => svc.periodo('2025-01-01', '2026-11-01')).toThrow(
      BadRequestException,
    );
  });

  it('está aislado por empresa: toda consulta lleva la distribuidora', async () => {
    const { svc, query } = servicio([[], [], [{ total: '0' }], []]);
    await svc.obtener('dist-A', undefined, undefined);
    expect(query).toHaveBeenCalledTimes(4);
    for (const [sql, params] of query.mock.calls as [string, unknown[]][]) {
      expect(sql).toContain('"distributor_id" = $1');
      expect(params[0]).toBe('dist-A');
    }
  });

  it('arma la respuesta con las cifras calculadas', async () => {
    const t = (s: number) => new Date(AHORA.getTime() - 3600_000 + s * 1000);
    const { svc } = servicio([
      [
        {
          orderId: 'o1',
          driverId: 'd1',
          driverName: 'Ana',
          status: 'accepted',
          offeredAt: t(0),
          respondedAt: t(12),
        },
        {
          orderId: 'o1',
          driverId: 'd2',
          driverName: null,
          status: 'expired',
          offeredAt: t(0),
          respondedAt: null,
        },
      ],
      [{ esperaDesde: t(-30), aceptadoEn: t(12) }],
      [{ total: '3' }],
      [
        { method: 'automatic' },
        { method: 'manual_override' },
        { method: null },
      ],
    ]);
    const r = await svc.obtener('dist-A', undefined, undefined);
    expect(r.pedidosDespachados).toBe(1);
    expect(r.ofertasPorPedido).toBe(2);
    expect(r.porcentajeAceptadas).toBe(50);
    expect(r.porcentajeVencidas).toBe(50);
    expect(r.respuestaDelChofer).toEqual({ mediana: 12, p90: 12 });
    expect(r.hastaAsignar.mediana).toBe(42);
    expect(r.pedidosSinChofer).toBe(3);
    expect(r.pedidosAsignados).toBe(3);
    expect(r.asignadosSinMetodo).toBe(1);
    expect(r.asignacionPorMetodo[0]).toEqual({
      method: 'automatic',
      cantidad: 1,
      porcentaje: 50,
    });
    expect(r.topChoferes[0]).toMatchObject({
      nombre: 'Ana',
      tasaAceptacion: 100,
    });
  });
});
