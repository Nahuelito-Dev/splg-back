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

  it.each([0, 1, 300, 5000])(
    'acepta un radio por terminar de 0 a 5000 m (%s)',
    async (m) => {
      expect(
        await camposInvalidos({ ...valido, finishingRadiusMeters: m }),
      ).toEqual([]);
    },
  );

  it.each([-1, 5001, 10.5, '300'])(
    'rechaza un radio por terminar fuera de 0..5000 m o no entero (%s)',
    async (m) => {
      expect(
        await camposInvalidos({ ...valido, finishingRadiusMeters: m }),
      ).toEqual(['finishingRadiusMeters']);
    },
  );

  it.each([0, 150, 5000])(
    'acepta el radio de llegada entre 0 y 5000 m (%s)',
    async (m) => {
      expect(await camposInvalidos({ arrivalRadiusMeters: m })).toEqual([]);
    },
  );

  it.each([-1, 5001, 10.5, '150'])(
    'rechaza el radio de llegada fuera de 0..5000 m o no entero (%s)',
    async (m) => {
      expect(await camposInvalidos({ arrivalRadiusMeters: m })).toEqual([
        'arrivalRadiusMeters',
      ]);
    },
  );
});
