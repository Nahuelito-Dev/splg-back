import type { DataSource } from 'typeorm';
import type { RedisService } from '../redis/redis.service';
import type { EntityPhotoService } from '../s3/entity-photo.service';
import { LiveFleetService } from './live-fleet.service';

const DIST = 'dist-a';
const INICIO = new Date('2026-11-21T12:00:00.000Z');

const vehiculo = (n: number, over: Record<string, unknown> = {}) => ({
  carId: `car-${n}`,
  deliveryId: `del-${n}`,
  inUseSince: new Date('2026-11-21T10:00:00.000Z'),
  patent: `AA00${n}BB`,
  typeCar: 'Camioneta',
  description: 'Toyota Hilux',
  capacityUnits: 40,
  carPhotoKey: `cars/${n}.jpg`,
  driverUserId: `user-${n}`,
  driverName: `Chofer ${n}`,
  driverPhone: '+5493764000000',
  driverPhotoKey: null,
  ...over,
});

const destino = (orderId: string, orderStatus: string) => ({
  orderId,
  orderStatus,
  customerName: `Cliente ${orderId}`,
  address: `Calle ${orderId}`,
  lat: '-27.36',
  lng: '-55.9',
});

interface Datos {
  enUso: unknown[];
  stock: unknown[];
  cargas: unknown[];
  hojas: unknown[];
  paradas: unknown[];
  pedidos: unknown[];
}

function armar(datos: Partial<Datos>) {
  const d: Datos = {
    enUso: [],
    stock: [],
    cargas: [],
    hojas: [],
    paradas: [],
    pedidos: [],
    ...datos,
  };
  const query = jest.fn<Promise<unknown[]>, [string, unknown[]]>((sql) => {
    if (sql.includes('FROM "vehicle_assignment"'))
      return Promise.resolve(d.enUso);
    if (sql.includes('FROM "stock_balance"')) return Promise.resolve(d.stock);
    if (sql.includes('FROM "truck_load"')) return Promise.resolve(d.cargas);
    if (sql.includes('FROM "route_batch" b')) return Promise.resolve(d.hojas);
    if (sql.includes('FROM "route_batch_stop"'))
      return Promise.resolve(d.paradas);
    if (sql.includes('FROM "order" o')) return Promise.resolve(d.pedidos);
    return Promise.reject(new Error(`consulta inesperada: ${sql}`));
  });
  const getDriversLastLocations = jest.fn((userIds: readonly string[]) =>
    Promise.resolve(
      new Map(
        userIds
          .filter((id) => id === 'user-1')
          .map((id) => [
            id,
            { lat: -27.3, lng: -55.8, at: '2026-11-21T12:30:00.000Z' },
          ]),
      ),
    ),
  );
  const urlDe = jest.fn((key: string | null) =>
    Promise.resolve(key ? `https://s3.test/${key}` : null),
  );
  const service = new LiveFleetService(
    { query } as unknown as DataSource,
    { getDriversLastLocations } as unknown as RedisService,
    { urlDe } as unknown as EntityPhotoService,
  );
  return { service, query, getDriversLastLocations, urlDe };
}

describe('LiveFleetService.vehiculos', () => {
  it('sin vehículos en uso responde vacío con una sola consulta', async () => {
    const { service, query, getDriversLastLocations } = armar({});
    const r = await service.vehiculos(DIST);
    expect(r.vehicles).toEqual([]);
    expect(Number.isNaN(Date.parse(r.generatedAt))).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
    expect(getDriversLastLocations).not.toHaveBeenCalled();
  });

  it('arma el vehículo en ruta: chofer, carga en por ciento, hoja con avance, paradas y posición', async () => {
    const { service } = armar({
      enUso: [vehiculo(1)],
      stock: [{ carId: 'car-1', full: 20, empty: 12, defective: 1 }],
      cargas: [
        { carId: 'car-1', loadId: 'load-1', number: 7, status: 'on_route' },
      ],
      hojas: [
        {
          sheetId: 'sheet-1',
          carId: 'car-1',
          deliveryId: 'del-1',
          number: 3,
          status: 'assigned',
          planDate: '2026-11-21',
          startedAt: INICIO,
          plannedStartAt: INICIO,
        },
      ],
      paradas: [
        {
          sheetId: 'sheet-1',
          sequence: 1,
          active: true,
          removedReason: null,
          removedAt: null,
          etaAt: new Date('2026-11-21T12:20:00.000Z'),
          ...destino('o1', 'delivered'),
        },
        {
          sheetId: 'sheet-1',
          sequence: 2,
          active: true,
          removedReason: null,
          removedAt: null,
          etaAt: new Date('2026-11-21T13:05:00.000Z'),
          ...destino('o2', 'on_the_way'),
        },
      ],
      // El pedido en camino ya está en la hoja: no se repite como pedido suelto.
      pedidos: [{ deliveryId: 'del-1', ...destino('o2', 'on_the_way') }],
    });
    const { vehicles } = await service.vehiculos(DIST);
    expect(vehicles).toHaveLength(1);
    expect(vehicles[0]).toEqual({
      carId: 'car-1',
      patent: 'AA001BB',
      typeCar: 'Camioneta',
      description: 'Toyota Hilux',
      photoUrl: 'https://s3.test/cars/1.jpg',
      status: 'on_route',
      inUseSince: '2026-11-21T10:00:00.000Z',
      driver: {
        deliveryId: 'del-1',
        userId: 'user-1',
        name: 'Chofer 1',
        phone: '+5493764000000',
        photoUrl: null,
      },
      load: {
        truckLoadId: 'load-1',
        truckLoadNumber: 7,
        truckLoadStatus: 'on_route',
        fullUnits: 20,
        emptyUnits: 12,
        defectiveUnits: 1,
        unitsOnBoard: 33,
        capacityUnits: 40,
        percent: 83,
      },
      sheet: {
        id: 'sheet-1',
        number: 3,
        status: 'assigned',
        planDate: '2026-11-21',
        plannedStartAt: INICIO.toISOString(),
        startedAt: INICIO.toISOString(),
        total: 2,
        delivered: 1,
        failed: 0,
        pending: 1,
        estimatedEndAt: '2026-11-21T13:05:00.000Z',
      },
      stops: [
        {
          orderId: 'o1',
          source: 'route_sheet',
          sequence: 1,
          progress: 'delivered',
          customerName: 'Cliente o1',
          address: 'Calle o1',
          lat: -27.36,
          lng: -55.9,
          etaAt: '2026-11-21T12:20:00.000Z',
        },
        {
          orderId: 'o2',
          source: 'route_sheet',
          sequence: 2,
          progress: 'on_the_way',
          customerName: 'Cliente o2',
          address: 'Calle o2',
          lat: -27.36,
          lng: -55.9,
          etaAt: '2026-11-21T13:05:00.000Z',
        },
      ],
      location: { lat: -27.3, lng: -55.8, at: '2026-11-21T12:30:00.000Z' },
    });
  });

  it('sin hoja, sin stock, sin capacidad y sin foto: esperando, con todo en cero o null', async () => {
    const { service } = armar({
      enUso: [vehiculo(2, { capacityUnits: null, carPhotoKey: null })],
    });
    const [v] = (await service.vehiculos(DIST)).vehicles;
    expect(v.status).toBe('waiting');
    expect(v.photoUrl).toBeNull();
    expect(v.sheet).toBeNull();
    expect(v.stops).toEqual([]);
    expect(v.location).toBeNull();
    expect(v.load).toEqual({
      truckLoadId: null,
      truckLoadNumber: null,
      truckLoadStatus: null,
      fullUnits: 0,
      emptyUnits: 0,
      defectiveUnits: 0,
      unitsOnBoard: 0,
      capacityUnits: null,
      percent: null,
    });
  });

  it('un pedido en curso fuera de una hoja pone al vehículo en ruta y sale como parada suelta', async () => {
    const { service } = armar({
      enUso: [vehiculo(2)],
      pedidos: [
        { deliveryId: 'del-2', ...destino('o9', 'on_the_way') },
        { deliveryId: 'del-2', ...destino('o8', 'accepted') },
      ],
    });
    const [v] = (await service.vehiculos(DIST)).vehicles;
    expect(v.status).toBe('on_route');
    expect(
      v.stops.map((s) => [
        s.orderId,
        s.source,
        s.sequence,
        s.progress,
        s.etaAt,
      ]),
    ).toEqual([
      ['o9', 'order', null, 'on_the_way', null],
      ['o8', 'order', null, 'pending', null],
    ]);
  });

  it('la hoja confirmada sin iniciar deja al vehículo esperando; la de otro chofer no se muestra', async () => {
    const hoja = (carId: string, deliveryId: string) => ({
      sheetId: `sheet-${carId}`,
      carId,
      deliveryId,
      number: 1,
      status: 'confirmed',
      planDate: '2026-11-21',
      startedAt: null,
      plannedStartAt: null,
    });
    const { service, query } = armar({
      enUso: [vehiculo(1), vehiculo(2)],
      hojas: [hoja('car-1', 'del-1'), hoja('car-2', 'otro-chofer')],
    });
    const { vehicles } = await service.vehiculos(DIST);
    expect(
      vehicles.map((v) => [v.carId, v.status, v.sheet?.id ?? null]),
    ).toEqual([
      ['car-1', 'waiting', 'sheet-car-1'],
      ['car-2', 'waiting', null],
    ]);
    const paradas = query.mock.calls.find(([sql]) =>
      sql.includes('FROM "route_batch_stop"'),
    );
    expect(paradas?.[1]).toEqual([DIST, ['sheet-car-1']]);
  });

  it('ordena primero los que están en ruta y conserva el orden por patente', async () => {
    const { service } = armar({
      enUso: [vehiculo(1), vehiculo(2), vehiculo(3)],
      pedidos: [{ deliveryId: 'del-3', ...destino('o1', 'accepted') }],
    });
    const { vehicles } = await service.vehiculos(DIST);
    expect(vehicles.map((v) => v.carId)).toEqual(['car-3', 'car-1', 'car-2']);
  });

  it('toda consulta va acotada a la distribuidora y la cantidad no crece con la flota', async () => {
    const hoja = (n: number) => ({
      sheetId: `sheet-${n}`,
      carId: `car-${n}`,
      deliveryId: `del-${n}`,
      number: n,
      status: 'assigned',
      planDate: '2026-11-21',
      startedAt: INICIO,
      plannedStartAt: null,
    });
    const { service, query, urlDe, getDriversLastLocations } = armar({
      enUso: [vehiculo(1), vehiculo(2), vehiculo(3)],
      hojas: [hoja(1), hoja(2), hoja(3)],
    });
    await service.vehiculos(DIST);
    expect(query).toHaveBeenCalledTimes(6);
    for (const [sql, params] of query.mock.calls) {
      expect(sql).toContain('"distributor_id" = $1');
      expect(params[0]).toBe(DIST);
    }
    expect(urlDe).toHaveBeenCalledTimes(6);
    // La posición de toda la flota se pide en una sola lectura por lote.
    expect(getDriversLastLocations).toHaveBeenCalledTimes(1);
    expect(getDriversLastLocations).toHaveBeenCalledWith([
      'user-1',
      'user-2',
      'user-3',
    ]);
  });

  it('si el radar no contesta, la posición sale null y la respuesta no se rompe', async () => {
    const { service, getDriversLastLocations } = armar({
      enUso: [vehiculo(1)],
    });
    getDriversLastLocations.mockRejectedValue(new Error('redis caído'));
    const [v] = (await service.vehiculos(DIST)).vehicles;
    expect(v.location).toBeNull();
  });
});
