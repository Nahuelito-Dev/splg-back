import { NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { UpsertThresholdsDto } from '../dto/stock-threshold.dto';
import { StockThresholdService } from './stock-threshold.service';

const DIST = 'dddddddd-0000-4000-8000-000000000001';
const W1 = 'a0000000-0000-4000-8000-000000000001';
const W2 = 'a0000000-0000-4000-8000-000000000002';
const G1 = '10000000-0000-4000-8000-000000000001';
const G2 = '10000000-0000-4000-8000-000000000002';

function armar(over: { depositos: string[]; garrafas: string[] }) {
  const manager = {
    query: jest.fn((sql: string) => {
      if (sql.includes('FROM "warehouse"')) {
        return Promise.resolve(
          over.depositos.map((id) => ({ warehouse_id: id })),
        );
      }
      if (sql.includes('SELECT "gas_cylinder_id" FROM "gas_cylinder"')) {
        return Promise.resolve(
          over.garrafas.map((id) => ({ gas_cylinder_id: id })),
        );
      }
      return Promise.resolve([]);
    }),
  } as unknown as EntityManager;
  const dataSource = {
    transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
      cb(manager),
    ),
    query: jest.fn().mockResolvedValue([]),
  } as unknown as DataSource;
  return { service: new StockThresholdService(dataSource), manager };
}

const dto = (filas: Array<{ w: string; g: string }>): UpsertThresholdsDto =>
  ({
    thresholds: filas.map((f) => ({
      warehouseId: f.w,
      gasCylinderId: f.g,
      minFull: 2,
    })),
  }) as UpsertThresholdsDto;

describe('StockThresholdService.upsert — renglón que falla', () => {
  it('numera con el body original aunque haya un renglón repetido', async () => {
    const { service } = armar({ depositos: [W1], garrafas: [G1] });
    const error: unknown = await service
      .upsert(
        dto([
          { w: W1, g: G1 },
          { w: W1, g: G1 },
          { w: W2, g: G1 },
        ]),
        DIST,
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as Error).message).toBe(
      'Depósito del renglón 3 no encontrado',
    );
  });

  it('informa el primero que falla en el orden del body, sea depósito o garrafa', async () => {
    const { service } = armar({ depositos: [W1], garrafas: [G1] });
    const error: unknown = await service
      .upsert(
        dto([
          { w: W1, g: G1 },
          { w: W1, g: G2 },
          { w: W2, g: G1 },
        ]),
        DIST,
      )
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      'Garrafa del renglón 2 no encontrada',
    );
  });
});
