import { DataSource } from 'typeorm';
import { TruckLoadStatus } from '../domain/truck-load.enums';
import { TruckLoadLookupService } from './truck-load-lookup.service';

function armar(cargas: unknown[], saldos: unknown[] = []) {
  const query = jest
    .fn()
    .mockResolvedValueOnce(cargas)
    .mockResolvedValueOnce(saldos);
  const svc = new TruckLoadLookupService({ query } as unknown as DataSource);
  return { svc, query };
}

describe('TruckLoadLookupService', () => {
  it('sin carga abierta: null (y no lee saldos)', async () => {
    const { svc, query } = armar([]);
    expect(await svc.cargaAbiertaDelChofer('d1', 'dl1')).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('la carga abierta del chofer, de la distribuidora, con las llenas que tiene hoy el camión', async () => {
    const { svc, query } = armar(
      [
        {
          load_id: 'l1',
          number: 7,
          status: TruckLoadStatus.ON_ROUTE,
          car_id: 'c1',
          car_patent: 'AB123CD',
        },
      ],
      [
        { gas_cylinder_id: 'g10', quantity: 8 },
        { gas_cylinder_id: 'g15', quantity: 2 },
      ],
    );
    const r = await svc.cargaAbiertaDelChofer('d1', 'dl1');
    expect(r).toEqual({
      loadId: 'l1',
      number: 7,
      status: TruckLoadStatus.ON_ROUTE,
      carId: 'c1',
      carPatent: 'AB123CD',
      fullOnTruck: new Map([
        ['g10', 8],
        ['g15', 2],
      ]),
    });
    const [sqlCarga, pCarga] = query.mock.calls[0] as [string, unknown[]];
    expect(sqlCarga).toContain(
      'l."distributor_id" = $1 AND l."delivery_id" = $2',
    );
    expect(pCarga[2]).toEqual(['loading', 'on_route', 'returned']);
    const [sqlSaldo, pSaldo] = query.mock.calls[1] as [string, unknown[]];
    expect(sqlSaldo).toContain(`b."condition" = 'full'`);
    expect(pSaldo).toEqual(['c1', 'd1']);
  });
});
