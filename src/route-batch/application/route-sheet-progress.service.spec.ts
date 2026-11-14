import { EntityManager } from 'typeorm';
import { RouteBatchStop } from '../../order/entities/route-batch-stop.entity';
import { RedisService } from '../../redis/redis.service';
import { RouteBatchStatus } from '../domain/route-batch.enums';
import { instanteDelDia } from '../domain/route-sheet-rules';
import { siguienteParada } from '../domain/route-sheet-execution';
import { RouteSheetDataService } from './route-sheet-data.service';
import {
  GPS_VIGENTE_MS,
  RouteSheetProgress,
  sinFranjaSiReintenta,
} from './route-sheet-progress.service';
import { RouteSheetWriter } from './route-sheet-writer.service';
import {
  DEPOSITO,
  DIA,
  DIST,
  PARAMS,
  calculadora,
  hoja,
  parada,
  pedido,
} from './route-sheet.fixtures';

const AHORA = instanteDelDia(DIA, '10:00');

function armar(o: {
  paradas: RouteBatchStop[];
  estados?: Record<string, string>;
  franjas?: Record<string, { desde: string; hasta: string }>;
  sinPunto?: string[];
  deposito?: typeof DEPOSITO | null;
  gps?: { lat: number; lng: number; at: string | null } | null | 'error';
}) {
  const writer = {
    parametros: jest.fn().mockResolvedValue(PARAMS),
    paradasActivas: jest.fn().mockResolvedValue(o.paradas),
    escribirOrden: jest.fn().mockResolvedValue(undefined),
  };
  const data = {
    pedidos: jest.fn((_d: string, ids: string[]) =>
      Promise.resolve(
        ids.map((id) =>
          pedido(id, {
            status: o.estados?.[id] ?? 'accepted',
            ...(o.sinPunto?.includes(id) ? { lat: null, lng: null } : {}),
            ...(o.franjas?.[id]
              ? {
                  slotStartMs: instanteDelDia(DIA, o.franjas[id].desde),
                  slotEndMs: instanteDelDia(DIA, o.franjas[id].hasta),
                }
              : {}),
          }),
        ),
      ),
    ),
    deposito: jest
      .fn()
      .mockResolvedValue(o.deposito === undefined ? DEPOSITO : o.deposito),
  };
  const redis = {
    getDriverLastLocation: jest.fn(() =>
      o.gps === 'error'
        ? Promise.reject(new Error('redis caído'))
        : Promise.resolve(o.gps ?? null),
    ),
  };
  const manager = { update: jest.fn().mockResolvedValue(undefined) };
  const svc = new RouteSheetProgress(
    data as unknown as RouteSheetDataService,
    calculadora(),
    writer as unknown as RouteSheetWriter,
    redis as unknown as RedisService,
  );
  return {
    svc,
    writer,
    data,
    manager,
    m: manager as unknown as EntityManager,
  };
}

const enCurso = () => hoja({ status: RouteBatchStatus.ASSIGNED });

describe('RouteSheetProgress', () => {
  it('paradas: cada activa con su pedido y su avance', async () => {
    const { svc, m } = armar({
      paradas: [parada('o1', 1), parada('o2', 2), parada('o3', 3)],
      estados: { o1: 'delivered', o2: 'on_the_way' },
    });
    const r = await svc.paradas(m, enCurso());
    expect(r.map((p) => [p.stop.orderId, p.progress])).toEqual([
      ['o1', 'delivered'],
      ['o2', 'on_the_way'],
      ['o3', 'pending'],
    ]);
  });

  it('paradas: una parada sin pedido visible queda pendiente y sin pedido', async () => {
    const { svc, m, data } = armar({ paradas: [parada('o1', 1)] });
    data.pedidos.mockResolvedValueOnce([]);
    const [p] = await svc.paradas(m, enCurso(), false);
    expect(p.pedido).toBeNull();
    expect(p.progress).toBe('pending');
  });

  describe('posicionDelChofer', () => {
    it('la reciente vale; la vieja, sin hora o con Redis caído, no', async () => {
      const reciente = new Date(AHORA - 60_000).toISOString();
      const vieja = new Date(AHORA - GPS_VIGENTE_MS - 1).toISOString();
      const casos: Array<[Parameters<typeof armar>[0]['gps'], boolean]> = [
        [{ lat: 1, lng: 2, at: reciente }, true],
        [{ lat: 1, lng: 2, at: vieja }, false],
        [{ lat: 1, lng: 2, at: null }, false],
        [null, false],
        ['error', false],
      ];
      for (const [gps, vale] of casos) {
        const { svc } = armar({ paradas: [], gps });
        const pos = await svc.posicionDelChofer('u1', AHORA);
        expect(pos === null).toBe(!vale);
      }
    });
  });

  describe('rehacer', () => {
    it('sin re-optimizar: conserva el orden, deja hechas y en camino adelante y estima desde el GPS', async () => {
      const { svc, m, writer, manager } = armar({
        paradas: [
          parada('o3', 1),
          parada('o1', 2),
          parada('o2', 3),
          parada('o4', 4),
        ],
        estados: { o3: 'delivered', o2: 'on_the_way' },
      });
      const r = await svc.rehacer(m, enCurso(), {
        reordenar: false,
        nowMs: AHORA,
        posicion: { lat: DEPOSITO.lat, lng: DEPOSITO.lng },
      });
      expect(r.origen).toBe('gps');
      expect(r.recorrido.enCamino).toBe('o2');
      expect(r.cola).toEqual(['o1', 'o4']);
      expect(writer.escribirOrden).toHaveBeenCalledWith(m, 'hoja-1', [
        'o3',
        'o2',
        'o1',
        'o4',
      ]);
      // ETA de lo que falta (en camino + cola), no de las hechas.
      expect(r.etas.map((e) => e.orderId)).toEqual(['o2', 'o1', 'o4']);
      expect(r.etas[0].etaMs).toBeGreaterThanOrEqual(AHORA);
      expect(manager.update).toHaveBeenCalledTimes(3);
      expect(manager.update).not.toHaveBeenCalledWith(
        RouteBatchStop,
        expect.objectContaining({ orderId: 'o3' }),
        expect.anything(),
      );
    });

    it('re-optimizando: la cola se reordena por cercanía y la en camino sigue primera', async () => {
      // o5 está más lejos que o1: desde el depósito conviene o1 antes.
      const { svc, m } = armar({
        paradas: [parada('o5', 1), parada('o1', 2)],
      });
      const r = await svc.rehacer(m, enCurso(), {
        reordenar: true,
        nowMs: AHORA,
        posicion: null,
      });
      expect(r.origen).toBe('warehouse');
      expect(r.cola).toEqual(['o1', 'o5']);
    });

    it('sin GPS mide desde la última entrega', async () => {
      const { svc, m, data } = armar({
        paradas: [parada('o1', 1), parada('o2', 2)],
        estados: { o1: 'delivered' },
      });
      const r = await svc.rehacer(m, enCurso(), {
        reordenar: false,
        nowMs: AHORA,
        posicion: null,
      });
      expect(r.origen).toBe('last_stop');
      expect(data.deposito).not.toHaveBeenCalled();
    });

    it('una parada agregada entra en la mejor posición de la cola, o en la pedida', async () => {
      const paradas = [parada('o1', 1), parada('o9', 2), parada('o2', 3)];
      const mejor = armar({ paradas });
      const r = await mejor.svc.rehacer(mejor.m, enCurso(), {
        reordenar: false,
        nowMs: AHORA,
        posicion: null,
        insertar: { orderId: 'o9' },
      });
      // o9 es la más lejana: la mejor posición es al final.
      expect(r.cola).toEqual(['o1', 'o2', 'o9']);
      const pedida = armar({ paradas });
      const r2 = await pedida.svc.rehacer(pedida.m, enCurso(), {
        reordenar: false,
        nowMs: AHORA,
        posicion: null,
        insertar: { orderId: 'o9', en: 1 },
      });
      expect(r2.cola).toEqual(['o9', 'o1', 'o2']);
    });

    it('la parada agregada nunca va antes de la que está en camino', async () => {
      const { svc, m } = armar({
        paradas: [parada('o5', 1), parada('o1', 2)],
        estados: { o5: 'on_the_way' },
      });
      const r = await svc.rehacer(m, enCurso(), {
        reordenar: false,
        nowMs: AHORA,
        posicion: null,
        insertar: { orderId: 'o1', en: 1 },
      });
      expect(r.recorrido.enCamino).toBe('o5');
      expect(r.cola).toEqual(['o1']);
      expect(r.etas[0].orderId).toBe('o5');
    });

    it('las paradas sin punto quedan al final de la cola y sin ETA', async () => {
      const { svc, m } = armar({
        paradas: [parada('o1', 1), parada('o2', 2), parada('o3', 3)],
        sinPunto: ['o1'],
      });
      const r = await svc.rehacer(m, enCurso(), {
        reordenar: true,
        nowMs: AHORA,
        posicion: null,
      });
      expect(r.cola[r.cola.length - 1]).toBe('o1');
      expect(r.etas.map((e) => e.orderId)).not.toContain('o1');
    });

    it('sin nada pendiente, o sin origen, sólo deja el orden', async () => {
      const hecha = armar({
        paradas: [parada('o1', 1)],
        estados: { o1: 'delivered' },
      });
      const r = await hecha.svc.rehacer(hecha.m, enCurso(), {
        reordenar: true,
        nowMs: AHORA,
        posicion: null,
      });
      expect(r.etas).toEqual([]);
      expect(hecha.writer.escribirOrden).toHaveBeenCalledWith(
        hecha.m,
        'hoja-1',
        ['o1'],
      );
      const sinOrigen = armar({ paradas: [parada('o1', 1)], deposito: null });
      const r2 = await sinOrigen.svc.rehacer(sinOrigen.m, enCurso(), {
        reordenar: false,
        nowMs: AHORA,
        posicion: null,
      });
      expect(r2.origen).toBe('none');
      expect(r2.etas).toEqual([]);
      expect(sinOrigen.manager.update).not.toHaveBeenCalled();
    });

    it('las ETAs llevan la franja de cada parada y marcan las tardes', async () => {
      const { svc, m } = armar({ paradas: [parada('o1', 1)] });
      const tarde = instanteDelDia(DIA, '23:00');
      const r = await svc.rehacer(m, enCurso(), {
        reordenar: false,
        nowMs: tarde,
        posicion: null,
      });
      expect(r.etas[0]).toMatchObject({
        orderId: 'o1',
        late: true,
        slotStartMs: instanteDelDia(DIA, '08:00'),
        slotEndMs: instanteDelDia(DIA, '20:00'),
      });
      expect(DIST).toBe('dist-1');
    });

    it('un reintento no conserva su franja: se lo estima en la jornada (no espera ni llega tarde por la franja comprada)', async () => {
      // o1 compró 08:00–09:00, falló a las 10:00 y vuelve al final: con su
      // franja llegaría tarde; sin franja fija, la hora sale del recálculo.
      const { svc, m } = armar({
        paradas: [
          parada('o1', 1, { failedAttempts: 1, lastFailedAt: new Date(1) }),
          parada('o2', 2),
        ],
        franjas: { o1: { desde: '08:00', hasta: '09:00' } },
      });
      const r = await svc.rehacer(m, enCurso(), {
        reordenar: true,
        nowMs: AHORA,
        posicion: null,
      });
      const o1 = r.etas.find((e) => e.orderId === 'o1');
      expect(o1).toMatchObject({
        late: false,
        slotStartMs: instanteDelDia(DIA, '08:00'),
        slotEndMs: instanteDelDia(DIA, '20:00'),
      });
      // Sin reintento, la misma franja comprada sí la marca tarde.
      const t2 = armar({
        paradas: [parada('o1', 1), parada('o2', 2)],
        franjas: { o1: { desde: '08:00', hasta: '09:00' } },
      });
      const r2 = await t2.svc.rehacer(t2.m, enCurso(), {
        reordenar: false,
        nowMs: AHORA,
        posicion: null,
      });
      expect(r2.etas.find((e) => e.orderId === 'o1')).toMatchObject({
        late: true,
        slotEndMs: instanteDelDia(DIA, '09:00'),
      });
    });

    it('o2 en camino falla (vuelve a aceptado con un intento): el recorrido devuelto ya está reordenado y la siguiente es o3', async () => {
      const { svc, m, writer } = armar({
        paradas: [
          parada('o1', 1),
          parada('o2', 2, { failedAttempts: 1, lastFailedAt: new Date(1) }),
          parada('o3', 3),
        ],
        estados: { o1: 'delivered' },
      });
      const r = await svc.rehacer(m, enCurso(), {
        reordenar: true,
        nowMs: AHORA,
        posicion: null,
      });
      expect(r.recorrido.pendientes).toEqual(['o3', 'o2']);
      expect(siguienteParada(r.recorrido)).toBe('o3');
      // Es el mismo orden que quedó escrito.
      expect(writer.escribirOrden).toHaveBeenCalledWith(m, 'hoja-1', [
        'o1',
        'o3',
        'o2',
      ]);
    });

    it('sinFranjaSiReintenta: sólo con un intento fallido y jornada conocida', () => {
      const p = pedido('o1', {
        slotStartMs: 1,
        slotEndMs: 2,
        dayStartMs: 0,
        dayEndMs: 10,
      });
      expect(sinFranjaSiReintenta(p, 0)).toBe(p);
      expect(sinFranjaSiReintenta(p, 1)).toMatchObject({
        slotStartMs: 0,
        slotEndMs: 10,
      });
      const sinJornada = { ...p, dayStartMs: null, dayEndMs: null };
      expect(sinFranjaSiReintenta(sinJornada, 1)).toBe(sinJornada);
    });

    it('las paradas que ya fallaron una vez quedan al final aunque se re-optimice (en el orden en que fallaron)', async () => {
      const { svc, m } = armar({
        paradas: [
          parada('o1', 1, { failedAttempts: 1, lastFailedAt: new Date(2) }),
          parada('o2', 2),
          parada('o3', 3, { failedAttempts: 1, lastFailedAt: new Date(1) }),
          parada('o4', 4),
        ],
      });
      const r = await svc.rehacer(m, enCurso(), {
        reordenar: true,
        nowMs: AHORA,
        posicion: null,
      });
      expect(r.cola.slice(-2)).toEqual(['o3', 'o1']);
      expect(r.cola.slice(0, 2).sort()).toEqual(['o2', 'o4']);
    });
  });
});
