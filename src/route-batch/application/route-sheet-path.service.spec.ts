import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { RouteBatchStop } from '../../order/entities/route-batch-stop.entity';
import { RedisService } from '../../redis/redis.service';
import { codificarPolilinea } from '../../routes/polyline';
import { RoutePathService } from '../../routes/route-path.service';
import { FetchFn } from '../../routes/routes.service';
import { RouteSheetDataService } from './route-sheet-data.service';
import { RouteSheetPathService, firma } from './route-sheet-path.service';
import { RouteSheetQueryService } from './route-sheet-query.service';
import { DEPOSITO, DIST, hoja, parada, pedido } from './route-sheet.fixtures';
import { hojaNoEncontrada } from './route-sheet.exceptions';

interface CuerpoGoogle {
  origin: { location: { latLng: { latitude: number; longitude: number } } };
  destination: {
    location: { latLng: { latitude: number; longitude: number } };
  };
  intermediates?: Array<{
    location: { latLng: { latitude: number; longitude: number } };
  }>;
}

/** Google: un tramo de 1000 m / 60 s entre cada par de puntos pedidos. */
const google = (_url: string, init?: { body?: string }) => {
  const c = JSON.parse(init?.body ?? '{}') as CuerpoGoogle;
  const puntos = [c.origin, ...(c.intermediates ?? []), c.destination].map(
    (p) => ({
      lat: p.location.latLng.latitude,
      lng: p.location.latLng.longitude,
    }),
  );
  const tramos = puntos.length - 1;
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        routes: [
          {
            distanceMeters: 1000 * tramos,
            duration: `${60 * tramos}s`,
            polyline: { encodedPolyline: codificarPolilinea(puntos) },
            legs: Array.from({ length: tramos }, () => ({
              distanceMeters: 1000,
              duration: '60s',
            })),
          },
        ],
      }),
  });
};

describe('RouteSheetPathService', () => {
  let paradas: RouteBatchStop[];
  let pedidos: ReturnType<typeof pedido>[];
  let deposito: typeof DEPOSITO | null;
  let http: jest.Mock;
  let cache: Map<string, string>;
  let query: { detalleSinMapear: jest.Mock };
  let data: { pedidos: jest.Mock; deposito: jest.Mock };
  let stops: { find: jest.Mock };
  let service: RouteSheetPathService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    paradas = [parada('o1', 1), parada('o2', 2), parada('o3', 3)];
    pedidos = [pedido('o1'), pedido('o2'), pedido('o3')];
    deposito = { ...DEPOSITO };
    cache = new Map();
    http = jest.fn(google);
    query = { detalleSinMapear: jest.fn().mockResolvedValue(hoja()) };
    data = {
      pedidos: jest.fn((_d: string, ids: string[]) =>
        Promise.resolve(pedidos.filter((p) => ids.includes(p.orderId))),
      ),
      deposito: jest.fn(() => Promise.resolve(deposito)),
    };
    stops = { find: jest.fn(() => Promise.resolve(paradas)) };
    const redis = {
      get: jest.fn((k: string) => Promise.resolve(cache.get(k) ?? null)),
      setex: jest.fn((k: string, _t: number, v: string) => {
        cache.set(k, v);
        return Promise.resolve();
      }),
      del: jest.fn(),
      incrWithExpire: jest.fn().mockResolvedValue(1),
    };
    const env: Record<string, string> = { GOOGLE_DIRECTIONS_API_KEY: 'k' };
    const paths = new RoutePathService(
      { get: (k: string) => env[k] } as unknown as ConfigService,
      redis as unknown as RedisService,
      http as unknown as FetchFn,
    );
    service = new RouteSheetPathService(
      query as unknown as RouteSheetQueryService,
      data as unknown as RouteSheetDataService,
      stops as unknown as Repository<RouteBatchStop>,
      paths,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  const puntosPedidos = () => {
    const c = JSON.parse(
      (
        http.mock.calls[http.mock.calls.length - 1] as [
          string,
          { body: string },
        ]
      )[1].body,
    ) as CuerpoGoogle;
    return [c.origin, ...(c.intermediates ?? []), c.destination].map((p) => [
      p.location.latLng.latitude,
      p.location.latLng.longitude,
    ]);
  };

  it('depósito → paradas en orden → depósito, con un tramo por parada y la vuelta', async () => {
    const r = await service.recorrido(DIST, 'hoja-1');
    expect(query.detalleSinMapear).toHaveBeenCalledWith(DIST, 'hoja-1');
    expect(stops.find).toHaveBeenCalledWith({
      where: { batchId: 'hoja-1', active: true },
      order: { sequence: 'ASC' },
    });
    expect(data.pedidos).toHaveBeenCalledWith(DIST, ['o1', 'o2', 'o3']);
    expect(data.deposito).toHaveBeenCalledWith(DIST, DEPOSITO.warehouseId);
    expect(puntosPedidos()).toEqual([
      [DEPOSITO.lat, DEPOSITO.lng],
      ...pedidos.map((p) => [p.lat, p.lng]),
      [DEPOSITO.lat, DEPOSITO.lng],
    ]);
    expect(r).toEqual({
      sheetId: 'hoja-1',
      version: 3,
      provider: 'google',
      distanceMeters: 4000,
      durationSeconds: 240,
      encodedPolyline: expect.any(String) as string,
      legs: [
        { orderId: 'o1', distanceMeters: 1000, durationSeconds: 60 },
        { orderId: 'o2', distanceMeters: 1000, durationSeconds: 60 },
        { orderId: 'o3', distanceMeters: 1000, durationSeconds: 60 },
        { orderId: null, distanceMeters: 1000, durationSeconds: 60 },
      ],
      skippedOrderIds: [],
      warehouse: DEPOSITO,
    });
  });

  it('respeta el orden vigente de las paradas, no el de los pedidos', async () => {
    paradas = [parada('o3', 1), parada('o1', 2), parada('o2', 3)];
    const r = await service.recorrido(DIST, 'hoja-1');
    expect(r.legs.map((l) => l.orderId)).toEqual(['o3', 'o1', 'o2', null]);
    expect(puntosPedidos()[1]).toEqual([pedidos[2].lat, pedidos[2].lng]);
  });

  it('saltea las paradas sin coordenadas (o cuyo pedido no vino) y las informa', async () => {
    pedidos[1] = pedido('o2', { lat: null, lng: null });
    paradas.push(parada('o9', 4));
    const r = await service.recorrido(DIST, 'hoja-1');
    expect(r.skippedOrderIds).toEqual(['o2', 'o9']);
    expect(r.legs.map((l) => l.orderId)).toEqual(['o1', 'o3', null]);
  });

  it('sin paradas con coordenadas: 200 con el recorrido vacío, sin consultar al proveedor', async () => {
    pedidos = pedidos.map((p) => ({ ...p, lat: null, lng: null }));
    const r = await service.recorrido(DIST, 'hoja-1');
    expect(r).toMatchObject({
      provider: null,
      distanceMeters: 0,
      durationSeconds: 0,
      encodedPolyline: '',
      legs: [],
      skippedOrderIds: ['o1', 'o2', 'o3'],
      warehouse: DEPOSITO,
    });
    expect(http).not.toHaveBeenCalled();
  });

  it('hoja sin paradas: vacío', async () => {
    paradas = [];
    const r = await service.recorrido(DIST, 'hoja-1');
    expect(r.provider).toBeNull();
    expect(r.skippedOrderIds).toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });

  it('sin depósito ubicado: de la primera a la última parada; con una sola, vacío', async () => {
    deposito = null;
    const r = await service.recorrido(DIST, 'hoja-1');
    expect(r.warehouse).toBeNull();
    // El de la hoja dado de baja o sin ubicación no se reemplaza por el
    // predeterminado: es el mismo depósito que usa el cálculo de horarios.
    expect(data.deposito).toHaveBeenCalledTimes(1);
    expect(data.deposito).toHaveBeenCalledWith(DIST, DEPOSITO.warehouseId);
    expect(r.legs.map((l) => l.orderId)).toEqual(['o2', 'o3']);
    paradas = [parada('o1', 1)];
    const una = await service.recorrido(DIST, 'hoja-1');
    expect(una.provider).toBeNull();
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('hoja ajena o inexistente: 404 sin tocar nada más', async () => {
    query.detalleSinMapear.mockRejectedValue(hojaNoEncontrada());
    await expect(service.recorrido('otra', 'hoja-1')).rejects.toMatchObject({
      status: 404,
    });
    expect(stops.find).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
  });

  it('caché: la segunda lectura de la hoja sin cambios no consulta; cambiar el orden sí', async () => {
    const primera = await service.recorrido(DIST, 'hoja-1');
    // Otra versión (p. ej. cambió el chofer) pero las mismas paradas: no se recalcula.
    query.detalleSinMapear.mockResolvedValue(hoja({ version: 4 }));
    const segunda = await service.recorrido(DIST, 'hoja-1');
    expect(http).toHaveBeenCalledTimes(1);
    expect(segunda).toEqual({ ...primera, version: 4 });

    paradas = [parada('o2', 1), parada('o1', 2), parada('o3', 3)];
    const otra = await service.recorrido(DIST, 'hoja-1');
    expect(http).toHaveBeenCalledTimes(2);
    expect(otra.legs.map((l) => l.orderId)).toEqual(['o2', 'o1', 'o3', null]);
  });

  it('caché: mover la dirección de una parada también recalcula', async () => {
    await service.recorrido(DIST, 'hoja-1');
    pedidos[0] = pedido('o1', { lat: -27.5, lng: -55.5 });
    await service.recorrido(DIST, 'hoja-1');
    expect(http).toHaveBeenCalledTimes(2);
  });

  it('la firma cambia con el orden, las coordenadas o el pedido, y es estable', () => {
    const a = { orderId: 'o1', lat: 1, lng: 2 };
    const b = { orderId: 'o2', lat: 3, lng: 4 };
    expect(firma([a, b])).toBe(firma([{ ...a }, { ...b }]));
    expect(firma([a, b])).not.toBe(firma([b, a]));
    expect(firma([a, b])).not.toBe(firma([a, { ...b, lat: 3.00001 }]));
    expect(firma([a, b])).not.toBe(firma([a, { ...b, orderId: 'o3' }]));
    expect(firma([a, b])).toMatch(/^[0-9a-f]{32}$/);
  });
});
