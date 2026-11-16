import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ArrivedDto } from './arrived.dto';

async function camposInvalidos(cuerpo: Record<string, unknown>) {
  const errores = await validate(plainToInstance(ArrivedDto, cuerpo));
  return errores.map((error) => error.property).sort();
}

describe('ArrivedDto', () => {
  it('acepta coordenadas numéricas en los límites geográficos', async () => {
    expect(await camposInvalidos({ latitude: -90, longitude: -180 })).toEqual(
      [],
    );
    expect(await camposInvalidos({ latitude: 90, longitude: 180 })).toEqual([]);
  });

  it.each([
    ['sin latitud', { longitude: -55.8961 }, ['latitude']],
    ['sin longitud', { latitude: -27.3671 }, ['longitude']],
    ['latitud fuera de rango', { latitude: 90.1, longitude: 0 }, ['latitude']],
    [
      'longitud fuera de rango',
      { latitude: 0, longitude: -180.1 },
      ['longitude'],
    ],
    [
      'coordenada como texto',
      { latitude: '-27.3671', longitude: 0 },
      ['latitude'],
    ],
  ])('%s', async (_caso, cuerpo, campos) => {
    expect(await camposInvalidos(cuerpo)).toEqual(campos);
  });
});
