import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Order } from '../order/entities/order.entity';
import { OrderItem } from '../order/entities/order-item.entity';
import { FleetCostService } from '../fleet-expense/fleet-cost.service';
import { EntityPhotoService } from '../s3/entity-photo.service';
import { rangoDelInforme } from './rango-del-informe';
import { ReportsService } from './reports.service';

/** Un constructor de consultas simulado: registra cada llamada y devuelve filas fijas. */
function consulta(raw: unknown[] = [], uno: unknown = undefined) {
  const q = {
    select: jest.fn(),
    addSelect: jest.fn(),
    from: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    groupBy: jest.fn(),
    getRawMany: jest.fn().mockResolvedValue(raw),
    getRawOne: jest.fn().mockResolvedValue(uno),
  };
  for (const metodo of [
    q.select,
    q.addSelect,
    q.from,
    q.where,
    q.andWhere,
    q.groupBy,
  ]) {
    metodo.mockReturnValue(q);
  }
  return q;
}

const fila = (carId: string, extra: Record<string, unknown> = {}) => ({
  carId,
  carPatent: null,
  carBrand: null,
  carModel: null,
  fuel: 0,
  maintenance: 0,
  insurance: 0,
  fines: 0,
  accidents: 0,
  total: 0,
  km: 0,
  insuranceEstimated: false,
  ...extra,
});

const BOARD = [
  fila('a', {
    carPatent: 'AA123BB',
    carBrand: 'Fiat',
    carModel: 'Fiorino',
    fuel: 100,
    maintenance: 50,
    insurance: 20,
    fines: 10,
    accidents: 5,
    total: 185,
    km: 40.5,
    insuranceEstimated: true,
  }),
  fila('b'),
];

const RANGO = rangoDelInforme('2026-10-01', '2026-10-31');

function armar({
  porVehiculo = [] as unknown[],
  diasDeLaFlota = { daysInUse: '0' } as unknown,
  fotos = [] as unknown[],
  tablero = BOARD as unknown[],
} = {}) {
  const entregas = consulta(porVehiculo);
  const dias = consulta([], diasDeLaFlota);
  const consultasDePedidos = [entregas, dias];
  const consultaDeFotos = consulta(fotos);
  const orderRepository = {
    manager: { createQueryBuilder: jest.fn(() => consultaDeFotos) },
    createQueryBuilder: jest.fn(() => consultasDePedidos.shift()),
  };
  const fleet = {
    tablero: jest.fn().mockResolvedValue(tablero),
    costoDelVehiculo: jest.fn(),
  };
  const firmar = jest.fn(
    (
      items: Array<{ photoKey: string; photoSignedUrl?: string }>,
      claveDe: (i: { photoKey: string }) => string,
    ) => {
      for (const item of items) {
        item.photoSignedUrl = `https://s3.test/${claveDe(item)}`;
      }
      return Promise.resolve();
    },
  );
  const service = new ReportsService(
    orderRepository as unknown as Repository<Order>,
    {} as Repository<OrderItem>,
    fleet as unknown as FleetCostService,
    { firmar } as unknown as EntityPhotoService,
  );
  return {
    service,
    entregas,
    dias,
    consultaDeFotos,
    orderRepository,
    fleet,
    firmar,
  };
}

describe('ReportsService — utilización por vehículo', () => {
  it('agrega entregas, días, km y costos en consultas fijas, e incluye vehículos sin uso', async () => {
    const t = armar({
      porVehiculo: [{ vehicleId: 'a', deliveries: '4', daysInUse: '3' }],
      diasDeLaFlota: { daysInUse: '2' },
      fotos: [{ carId: 'a', photoKey: 'cars/d1/a' }],
    });

    const informe = await t.service.getVehicleUtilization(RANGO, 'd1');

    expect(informe.rows).toEqual([
      expect.objectContaining({
        vehicleId: 'a',
        plate: 'AA123BB',
        photo: 'https://s3.test/cars/d1/a',
        daysInUse: 3,
        km: 40.5,
        deliveries: 4,
        insuranceEstimated: true,
        costPerDelivery: 46.25,
        costPerKm: 4.57,
        costs: {
          fuel: 100,
          maintenance: 50,
          insurance: 20,
          other: 15,
          total: 185,
        },
      }),
      expect.objectContaining({
        vehicleId: 'b',
        photo: null,
        daysInUse: 0,
        km: 0,
        deliveries: 0,
        costPerDelivery: null,
        costPerKm: null,
      }),
    ]);
    // Los días de la flota son los distintos con entrega, no la suma por vehículo (3 + 0).
    expect(informe.totals).toEqual(
      expect.objectContaining({
        vehicles: 2,
        daysInUse: 2,
        km: 40.5,
        deliveries: 4,
        insuranceEstimated: true,
        costPerDelivery: 46.25,
        costPerKm: 4.57,
      }),
    );
    expect(t.fleet.tablero).toHaveBeenCalledWith(
      'd1',
      '2026-10-01',
      '2026-10-31',
    );
    expect(t.fleet.costoDelVehiculo).not.toHaveBeenCalled();
    // Dos consultas de pedidos y una de fotos, sin importar cuántos vehículos haya.
    expect(t.orderRepository.createQueryBuilder).toHaveBeenCalledTimes(2);
    expect(t.orderRepository.manager.createQueryBuilder).toHaveBeenCalledTimes(
      1,
    );
  });

  it('firma sólo la foto del vehículo, no la del dueño', async () => {
    const t = armar({ fotos: [{ carId: 'a', photoKey: 'cars/d1/a' }] });
    await t.service.getVehicleUtilization(RANGO, 'd1');
    expect(t.firmar).toHaveBeenCalledTimes(1);
    expect(t.firmar).toHaveBeenCalledWith(
      [expect.objectContaining({ carId: 'a', photoKey: 'cars/d1/a' })],
      expect.any(Function),
    );
    expect(t.consultaDeFotos.andWhere).toHaveBeenCalledWith(
      'c.photo_key IS NOT NULL',
    );
    expect(t.consultaDeFotos.where).toHaveBeenCalledWith(
      'c.distributor_id = :distributorId',
      { distributorId: 'd1' },
    );
  });

  it('las entregas se filtran por la distribuidora y por los instantes del rango, con el último día incluido', async () => {
    const t = armar();
    await t.service.getVehicleUtilization(
      rangoDelInforme('2026-10-05', '2026-10-05'),
      'd1',
    );
    for (const q of [t.entregas, t.dias]) {
      expect(q.where).toHaveBeenCalledWith(
        'order.distributorId = :distributorId',
        { distributorId: 'd1' },
      );
      // Un solo día (from = to): [00:00 del 5, 00:00 del 6) en hora argentina.
      expect(q.andWhere).toHaveBeenCalledWith(
        'order.deliveredAt >= :start AND order.deliveredAt < :end',
        {
          start: new Date('2026-10-05T03:00:00.000Z'),
          end: new Date('2026-10-06T03:00:00.000Z'),
        },
      );
    }
  });

  it('con vehicleId pide el costo de ese vehículo (no el tablero de todos) y filtra las entregas', async () => {
    const t = armar({
      porVehiculo: [{ vehicleId: 'a', deliveries: '1', daysInUse: '1' }],
      diasDeLaFlota: { daysInUse: '1' },
    });
    t.fleet.costoDelVehiculo.mockResolvedValue(BOARD[0]);

    const informe = await t.service.getVehicleUtilization(RANGO, 'd1', 'a');

    expect(t.fleet.costoDelVehiculo).toHaveBeenCalledWith(
      'a',
      'd1',
      '2026-10-01',
      '2026-10-31',
    );
    expect(t.fleet.tablero).not.toHaveBeenCalled();
    expect(informe.rows).toHaveLength(1);
    expect(t.entregas.andWhere).toHaveBeenCalledWith(
      'order.vehicleCarId = :vehicleId',
      { vehicleId: 'a' },
    );
  });

  it('el vehículo de otra distribuidora es un 404 y no consulta entregas', async () => {
    const t = armar();
    t.fleet.costoDelVehiculo.mockRejectedValue(
      new NotFoundException('Vehículo no encontrado'),
    );
    await expect(
      t.service.getVehicleUtilization(RANGO, 'd1', 'ajeno'),
    ).rejects.toThrow('Vehículo no encontrado');
    expect(t.orderRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('sin vehículos no consulta fotos y devuelve ceros', async () => {
    const t = armar({ tablero: [] });
    const informe = await t.service.getVehicleUtilization(RANGO, 'd1');
    expect(informe.rows).toEqual([]);
    expect(informe.totals).toEqual(
      expect.objectContaining({ vehicles: 0, daysInUse: 0, costPerKm: null }),
    );
    expect(t.orderRepository.manager.createQueryBuilder).not.toHaveBeenCalled();
  });
});
