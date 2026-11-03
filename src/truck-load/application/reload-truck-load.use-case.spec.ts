import type { DataSource } from 'typeorm';
import type { StockLocationService } from '../../stock/application/stock-location.service';
import type { StockLedgerPort } from '../../stock/domain/ports/stock-ledger.port';
import { TruckLoadStatus } from '../domain/truck-load.enums';
import { TruckLoad } from '../entities/truck-load.entity';
import { MAX_RENGLONES } from '../dto/truck-load.dto';
import { ReloadTruckLoadUseCase } from './reload-truck-load.use-case';
import { TransicionDeCargaInvalidaError } from './truck-load-support';

const uuid = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function armar(
  status: TruckLoadStatus,
  tiposEnLaCarga: number,
  garrafasAjenas: string[] = [],
) {
  const carga = {
    loadId: 'carga-1',
    number: 7,
    carId: 'car-1',
    originLocationId: 'dep',
    status,
  } as TruckLoad;
  const manager = {
    getRepository: jest.fn(() => ({
      createQueryBuilder: jest.fn(() => {
        const qb: Record<string, jest.Mock> = {};
        for (const m of ['setLock', 'where']) qb[m] = jest.fn(() => qb);
        qb.getOne = jest.fn().mockResolvedValue(carga);
        return qb;
      }),
    })),
    query: jest.fn((sql: string, params: unknown[] = []) =>
      Promise.resolve(
        sql.includes('COUNT(DISTINCT')
          ? [{ tipos: tiposEnLaCarga }]
          : sql.includes('SELECT "gas_cylinder_id" FROM "gas_cylinder"')
            ? (params[0] as string[])
                .filter((id) => !garrafasAjenas.includes(id))
                .map((id) => ({ gas_cylinder_id: id }))
            : [],
      ),
    ),
  };
  const dataSource = {
    transaction: jest.fn((fn: (m: typeof manager) => Promise<unknown>) =>
      fn(manager),
    ),
  } as unknown as DataSource;
  const ledger = {
    aplicar: jest.fn().mockResolvedValue({ batchId: 'b', movementIds: [] }),
  };
  const locations = {
    ubicacionDeVehiculo: jest.fn().mockResolvedValue({ locationId: 'camion' }),
  };
  const useCase = new ReloadTruckLoadUseCase(
    dataSource,
    ledger as unknown as StockLedgerPort,
    locations as unknown as StockLocationService,
  );
  return { useCase, ledger, manager };
}

const dto = (n: number) => ({
  items: Array.from({ length: n }, (_, i) => ({
    gasCylinderId: uuid(i + 1),
    quantity: 1,
  })),
});

describe('ReloadTruckLoadUseCase', () => {
  it('repone en ruta: mueve las llenas del depósito al camión y suma en los renglones', async () => {
    const { useCase, ledger, manager } = armar(TruckLoadStatus.ON_ROUTE, 3);
    await useCase.execute('carga-1', dto(2), 'dist', 'admin');
    expect(ledger.aplicar).toHaveBeenCalledTimes(1);
    expect(
      manager.query.mock.calls.some((c) =>
        String(c[0]).includes('INSERT INTO "truck_load_item"'),
      ),
    ).toBe(true);
  });

  it('una reposición que pasaría los tipos que se pueden declarar es 400 y no mueve stock', async () => {
    const { useCase, ledger } = armar(
      TruckLoadStatus.ON_ROUTE,
      MAX_RENGLONES + 1,
    );
    await expect(
      useCase.execute('carga-1', dto(2), 'dist', 'admin'),
    ).rejects.toThrow(
      `La carga llegaría a ${MAX_RENGLONES + 1} tipos de garrafa y el máximo es ${MAX_RENGLONES}`,
    );
    expect(ledger.aplicar).not.toHaveBeenCalled();
  });

  it('con exactamente el máximo de tipos todavía repone', async () => {
    const { useCase, ledger } = armar(TruckLoadStatus.ON_ROUTE, MAX_RENGLONES);
    await useCase.execute('carga-1', dto(1), 'dist', 'admin');
    expect(ledger.aplicar).toHaveBeenCalled();
  });

  it('sólo se repone en ruta: otro estado es 409', async () => {
    const { useCase, ledger } = armar(TruckLoadStatus.LOADING, 1);
    await expect(
      useCase.execute('carga-1', dto(1), 'dist', 'admin'),
    ).rejects.toBeInstanceOf(TransicionDeCargaInvalidaError);
    expect(ledger.aplicar).not.toHaveBeenCalled();
  });

  it('una garrafa inexistente dice el renglón del body y no mueve stock', async () => {
    const { useCase, ledger } = armar(TruckLoadStatus.ON_ROUTE, 1, [uuid(2)]);
    const error: unknown = await useCase
      .execute('carga-1', dto(2), 'dist', 'u1')
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      'Garrafa del renglón 2 no encontrada',
    );
    expect(ledger.aplicar).not.toHaveBeenCalled();
  });

  it('dos renglones de la misma garrafa son 400', async () => {
    const { useCase } = armar(TruckLoadStatus.ON_ROUTE, 1);
    await expect(
      useCase.execute(
        'carga-1',
        {
          items: [
            { gasCylinderId: uuid(1), quantity: 1 },
            { gasCylinderId: uuid(1), quantity: 2 },
          ],
        },
        'dist',
        'admin',
      ),
    ).rejects.toThrow(/dos renglones para la misma garrafa/);
  });
});
