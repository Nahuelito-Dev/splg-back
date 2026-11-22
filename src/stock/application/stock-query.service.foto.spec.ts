import type { DataSource } from 'typeorm';
import type { GasCylinderPhotoService } from '../../gascylinder/gascylinder-photo.service';
import type { OrderLookupService } from '../../order/lookup/order-lookup.service';
import { StockQueryService } from './stock-query.service';

const DIST = 'dddddddd-0000-4000-8000-000000000001';
const G1 = '10000000-0000-4000-8000-000000000001';
const G2 = '10000000-0000-4000-8000-000000000002';

function armar(fotos: Array<[string, string | null]> = []) {
  const query = jest.fn((sql: string): Promise<unknown[]> => {
    if (sql.includes('FROM "stock_balance" b') && sql.includes('l."kind"'))
      return Promise.resolve([
        {
          location_id: 'l-1',
          kind: 'warehouse',
          warehouse_id: 'w-1',
          car_id: null,
          name: 'Central',
          gas_cylinder_id: G1,
          type: '10kg',
          condition: 'full',
          quantity: 5,
          updatedAt: new Date(),
        },
        {
          location_id: 'l-1',
          kind: 'warehouse',
          warehouse_id: 'w-1',
          car_id: null,
          name: 'Central',
          gas_cylinder_id: G2,
          type: '15kg',
          condition: 'full',
          quantity: 3,
          updatedAt: new Date(),
        },
      ]);
    if (sql.includes('SUM(b."quantity") AS total') || sql.includes('GROUP BY'))
      return Promise.resolve([]);
    if (sql.includes('FROM "gas_cylinder"'))
      return Promise.resolve([
        { gas_cylinder_id: G1, type: '10kg', stock: 5 },
        { gas_cylinder_id: G2, type: '15kg', stock: 3 },
      ]);
    return Promise.resolve([]);
  });
  const productos = {
    urlsPorId: jest.fn(() => Promise.resolve(new Map(fotos))),
  };
  const service = new StockQueryService(
    { query } as unknown as DataSource,
    {
      reservedByCylinder: jest.fn().mockResolvedValue(new Map()),
    } as unknown as OrderLookupService,
    productos as unknown as GasCylinderPhotoService,
  );
  return { service, productos };
}

describe('StockQueryService · foto del producto', () => {
  it('saldos: cada fila lleva la foto firmada de su producto, o null', async () => {
    const { service, productos } = armar([[G1, 'https://s3.test/g1.jpg']]);
    const r = await service.saldos(DIST, {} as never);
    expect(r.map((f) => f.gasCylinderPhotoUrl)).toEqual([
      'https://s3.test/g1.jpg',
      null,
    ]);
    expect(productos.urlsPorId).toHaveBeenCalledTimes(1);
    expect(productos.urlsPorId).toHaveBeenCalledWith(DIST, [G1, G2]);
  });

  it('saldos sin fotos: todo null y los números no cambian', async () => {
    const { service } = armar([]);
    const r = await service.saldos(DIST, {} as never);
    expect(r.map((f) => f.gasCylinderPhotoUrl)).toEqual([null, null]);
    expect(r.map((f) => f.quantity)).toEqual([5, 3]);
  });

  it('resumen: cada tipo de garrafa lleva su foto, o null', async () => {
    const { service, productos } = armar([[G2, 'https://s3.test/g2.jpg']]);
    const r = await service.resumen(DIST);
    expect(r.map((f) => f.gasCylinderPhotoUrl)).toEqual([
      null,
      'https://s3.test/g2.jpg',
    ]);
    expect(productos.urlsPorId).toHaveBeenCalledTimes(1);
    expect(productos.urlsPorId).toHaveBeenCalledWith(DIST, [G1, G2]);
  });

  it('resumen sin fotos: todo null y el vendible sigue igual', async () => {
    const { service } = armar([]);
    const r = await service.resumen(DIST);
    expect(r.map((f) => f.gasCylinderPhotoUrl)).toEqual([null, null]);
    expect(r.map((f) => f.sellable)).toEqual([5, 3]);
  });
});
