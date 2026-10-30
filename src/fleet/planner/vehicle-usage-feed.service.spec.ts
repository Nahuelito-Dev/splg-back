import { DataSource } from 'typeorm';
import { CarService } from '../../car/car.service';
import { Car } from '../../car/entities/car.entity';
import { VehicleUsageFeedService } from './vehicle-usage-feed.service';

const AHORA = new Date('2026-10-30T15:00:00Z');
// Corrientes: 0,01° de latitud ≈ 1,11 km.
const parada = (car: string, iso: string, lat: number) => ({
  car_id: car,
  at: new Date(iso),
  lat,
  lng: -58.83,
});

describe('VehicleUsageFeedService', () => {
  let query: jest.Mock;
  let findAll: jest.Mock;
  let feed: VehicleUsageFeedService;
  let paradas: ReturnType<typeof parada>[];
  let lecturas: Array<{ car_id: string; at: Date; km: number }>;

  const upserts = () =>
    query.mock.calls
      .filter((c: unknown[]) =>
        String(c[0]).includes('INSERT INTO "vehicle_usage_log"'),
      )
      .map(
        (c: unknown[]) =>
          c[1] as [string, string, string, number, number, number],
      );

  beforeEach(() => {
    paradas = [];
    lecturas = [];
    findAll = jest
      .fn()
      .mockResolvedValue([{ carId: 'car-1' }, { carId: 'car-2' }] as Car[]);
    query = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('FROM "order"')) return Promise.resolve(paradas);
      if (sql.includes('FROM "fuel_load"')) return Promise.resolve(lecturas);
      return Promise.resolve([]);
    });
    feed = new VehicleUsageFeedService(
      { query } as unknown as DataSource,
      { findAll } as unknown as CarService,
    );
  });

  it('escribe los km de cada día con entregas: la distancia entre paradas por 1,3', async () => {
    paradas = [
      parada('car-1', '2026-10-28T13:00:00Z', -27.45),
      parada('car-1', '2026-10-28T14:00:00Z', -27.46),
      parada('car-1', '2026-10-28T15:00:00Z', -27.48),
    ];
    const r = await feed.alimentar('d1', AHORA);

    expect(r).toEqual({ vehiculos: 2, filas: 1 });
    const [fila] = upserts();
    expect(fila.slice(0, 3)).toEqual(['car-1', 'd1', '2026-10-28']);
    expect(fila[3]).toBeCloseTo(3.33 * 1.3, 1);
    expect(fila[4]).toBe(3);
  });

  it('es un upsert por vehículo y día: repetir la corrida no duplica', async () => {
    paradas = [
      parada('car-1', '2026-10-28T13:00:00Z', -27.45),
      parada('car-1', '2026-10-28T14:00:00Z', -27.46),
    ];
    await feed.alimentar('d1', AHORA);
    const sql = String(
      (query.mock.calls as string[][]).find((c) =>
        String(c[0]).includes('INSERT'),
      )?.[0],
    );
    expect(sql).toContain('ON CONFLICT ("car_id", "day") DO UPDATE');
  });

  it('el odómetro manda sobre el recorrido estimado', async () => {
    paradas = [
      parada('car-1', '2026-10-27T13:00:00Z', -27.45),
      parada('car-1', '2026-10-27T14:00:00Z', -27.46),
      parada('car-1', '2026-10-28T13:00:00Z', -27.45),
      parada('car-1', '2026-10-28T14:00:00Z', -27.46),
    ];
    lecturas = [
      { car_id: 'car-1', at: new Date('2026-10-26T15:00:00Z'), km: 1000 },
      { car_id: 'car-1', at: new Date('2026-10-28T15:00:00Z'), km: 1060 },
    ];
    await feed.alimentar('d1', AHORA);
    const kms = upserts().map((f) => f[3]);
    expect(kms).toEqual([30, 30]);
  });

  it('un día con una sola parada (sin tramo) no escribe un 0: no tiene dato', async () => {
    paradas = [parada('car-1', '2026-10-28T13:00:00Z', -27.45)];
    expect((await feed.alimentar('d1', AHORA)).filas).toBe(0);
  });

  it('no escribe hoy (el día no terminó) ni días sin nada', async () => {
    paradas = [
      parada('car-1', '2026-10-30T13:00:00Z', -27.45),
      parada('car-1', '2026-10-30T14:00:00Z', -27.46),
    ];
    const r = await feed.alimentar('d1', AHORA);
    expect(r.filas).toBe(0);
  });

  it('sin vehículos no consulta', async () => {
    findAll.mockResolvedValue([]);
    expect(await feed.alimentar('d1', AHORA)).toEqual({
      vehiculos: 0,
      filas: 0,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('consulta sólo la distribuidora pedida', async () => {
    await feed.alimentar('d1', AHORA);
    const consultas = query.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('"distributor_id" = $1'),
    );
    expect(consultas.length).toBeGreaterThanOrEqual(2);
    expect(
      consultas.every((c: unknown[]) => (c[1] as unknown[])[0] === 'd1'),
    ).toBe(true);
    expect(findAll).toHaveBeenCalledWith('d1');
  });

  it('lista las distribuidoras con vehículos', async () => {
    query.mockResolvedValueOnce([{ id: 'd1' }, { id: 'd2' }]);
    expect(await feed.distribuidorasConVehiculos()).toEqual(['d1', 'd2']);
  });
});
