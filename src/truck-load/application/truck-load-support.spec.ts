import { EntityManager } from 'typeorm';
import { GarrafaNoEncontradaEnStockError } from '../../stock/domain/errors/stock.errors';
import { bloquearGarrafasComoClaveForanea } from './truck-load-support';

const DIST = 'dddddddd-0000-4000-8000-000000000001';
const PRIMERA = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SEGUNDA = '00000000-0000-4000-8000-000000000000';
const OK = '10000000-0000-4000-8000-000000000001';

const managerCon = (existentes: string[]) =>
  ({
    query: jest.fn(() =>
      Promise.resolve(existentes.map((id) => ({ gas_cylinder_id: id }))),
    ),
  }) as unknown as EntityManager;

describe('bloquearGarrafasComoClaveForanea', () => {
  it('con varias faltantes informa el primer renglón del body, no el primero por id', async () => {
    const error: unknown = await bloquearGarrafasComoClaveForanea(
      managerCon([OK]),
      DIST,
      [OK, PRIMERA, SEGUNDA],
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GarrafaNoEncontradaEnStockError);
    expect((error as Error).message).toBe(
      'Garrafa del renglón 2 no encontrada',
    );
    expect((error as GarrafaNoEncontradaEnStockError).gasCylinderId).toBe(
      PRIMERA,
    );
  });

  it('si están todas no lanza', async () => {
    await expect(
      bloquearGarrafasComoClaveForanea(managerCon([OK]), DIST, [OK, OK]),
    ).resolves.toBeUndefined();
  });
});
