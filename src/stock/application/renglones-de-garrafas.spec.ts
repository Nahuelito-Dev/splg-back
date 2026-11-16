import { NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { exigirGarrafasDeLosRenglones } from './renglones-de-garrafas';

const DIST = 'dddddddd-0000-4000-8000-000000000001';
const A = '10000000-0000-4000-8000-00000000000a';
const B = '10000000-0000-4000-8000-00000000000b';
const X = '10000000-0000-4000-8000-0000000000ff';

function armar(existentes: string[]) {
  const query = jest.fn((_sql: string, params: unknown[]) =>
    Promise.resolve(
      (params[0] as string[])
        .filter((id) => existentes.includes(id))
        .map((id) => ({ gas_cylinder_id: id })),
    ),
  );
  return { manager: { query } as unknown as EntityManager, query };
}

describe('exigirGarrafasDeLosRenglones', () => {
  it('con un renglón repetido numera con el body original: [A, A, X] -> renglón 3', async () => {
    const { manager } = armar([A]);
    const error: unknown = await exigirGarrafasDeLosRenglones(manager, DIST, [
      A,
      A,
      X,
    ]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as Error).message).toBe(
      'Garrafa del renglón 3 no encontrada',
    );
    expect((error as Error).message).not.toContain(X);
  });

  it('informa el primero que falla en el orden del body', async () => {
    const { manager } = armar([B]);
    await expect(
      exigirGarrafasDeLosRenglones(manager, DIST, [X, B, A]),
    ).rejects.toThrow('Garrafa del renglón 1 no encontrada');
  });

  it('busca sólo en la distribuidora y no hace nada si todas están', async () => {
    const { manager, query } = armar([A, B]);
    await expect(
      exigirGarrafasDeLosRenglones(manager, DIST, [A, B, A]),
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('"distributor_id" = $2'),
      [[A, B], DIST],
    );
  });

  it('sin renglones no consulta', async () => {
    const { manager, query } = armar([]);
    await exigirGarrafasDeLosRenglones(manager, DIST, []);
    expect(query).not.toHaveBeenCalled();
  });
});
