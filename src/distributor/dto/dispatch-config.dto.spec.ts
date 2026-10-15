import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DispatchConfigDto } from './dispatch-config.dto';

/** Devuelve los campos con error de validación para un cuerpo dado. */
async function camposInvalidos(cuerpo: Record<string, unknown>) {
  const errores = await validate(plainToInstance(DispatchConfigDto, cuerpo));
  return errores.map((e) => e.property).sort();
}

describe('DispatchConfigDto (CU-171)', () => {
  const valido = { radiusStepsKm: [5, 10, 15, 20], offerTtlSeconds: 30 };

  it('acepta los valores por omisión', async () => {
    expect(await camposInvalidos(valido)).toEqual([]);
  });

  it('acepta los límites: 1 paso de 1 km, 8 pasos hasta 100 km, ventana de 10 y de 300 s', async () => {
    expect(
      await camposInvalidos({ radiusStepsKm: [1], offerTtlSeconds: 10 }),
    ).toEqual([]);
    expect(
      await camposInvalidos({
        radiusStepsKm: [1, 2, 3, 4, 5, 6, 7, 100],
        offerTtlSeconds: 300,
      }),
    ).toEqual([]);
  });

  it('rechaza la lista vacía', async () => {
    expect(await camposInvalidos({ ...valido, radiusStepsKm: [] })).toEqual([
      'radiusStepsKm',
    ]);
  });

  it('rechaza más de ocho pasos', async () => {
    expect(
      await camposInvalidos({
        ...valido,
        radiusStepsKm: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      }),
    ).toEqual(['radiusStepsKm']);
  });

  it('rechaza pasos repetidos', async () => {
    expect(
      await camposInvalidos({ ...valido, radiusStepsKm: [5, 10, 10] }),
    ).toEqual(['radiusStepsKm']);
  });

  it('rechaza pasos desordenados', async () => {
    expect(
      await camposInvalidos({ ...valido, radiusStepsKm: [10, 5, 20] }),
    ).toEqual(['radiusStepsKm']);
  });

  it.each([0, 0.5, 101, -3])(
    'rechaza un paso fuera de 1..100 km (%s)',
    async (km) => {
      expect(await camposInvalidos({ ...valido, radiusStepsKm: [km] })).toEqual(
        ['radiusStepsKm'],
      );
    },
  );

  it('rechaza pasos que no son números', async () => {
    expect(
      await camposInvalidos({ ...valido, radiusStepsKm: [5, '10'] }),
    ).toEqual(['radiusStepsKm']);
    expect(
      await camposInvalidos({ ...valido, radiusStepsKm: 'cinco' }),
    ).toEqual(['radiusStepsKm']);
  });

  it.each([9, 301, 0, -30, 30.5])(
    'rechaza una ventana fuera de 10..300 s o no entera (%s)',
    async (segundos) => {
      expect(
        await camposInvalidos({ ...valido, offerTtlSeconds: segundos }),
      ).toEqual(['offerTtlSeconds']);
    },
  );

  it('los dos campos son opcionales: lo que falta se lee con su valor por omisión', async () => {
    expect(await camposInvalidos({})).toEqual([]);
    expect(await camposInvalidos({ offerTtlSeconds: 60 })).toEqual([]);
    expect(await camposInvalidos({ radiusStepsKm: [5, 10] })).toEqual([]);
  });

  it('lo que viene se valida igual aunque el otro campo falte', async () => {
    expect(await camposInvalidos({ radiusStepsKm: [10, 5] })).toEqual([
      'radiusStepsKm',
    ]);
    expect(await camposInvalidos({ offerTtlSeconds: 9 })).toEqual([
      'offerTtlSeconds',
    ]);
  });
});
