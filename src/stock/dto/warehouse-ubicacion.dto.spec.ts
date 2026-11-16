import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import { crearValidationPipe } from '../../common/validation/validation-pipe';
import {
  CreateWarehouseDto,
  CreateWarehouseV2Dto,
  UpdateWarehouseV2Dto,
} from './warehouse.dto';

async function errores<T extends object>(clase: new () => T, plano: object) {
  const dto = plainToInstance(clase, plano);
  return (
    await validate(dto, { whitelist: true, forbidNonWhitelisted: true })
  ).map((e) => e.property);
}

const ALTA = { name: 'Galpón Posadas', code: 'POS' };
const POSADAS = { latitude: -27.3671, longitude: -55.8961 };

describe('ubicación del depósito en el alta y la edición (v2)', () => {
  it('el alta acepta las dos coordenadas o ninguna', async () => {
    expect(await errores(CreateWarehouseV2Dto, ALTA)).toEqual([]);
    expect(
      await errores(CreateWarehouseV2Dto, { ...ALTA, ...POSADAS }),
    ).toEqual([]);
  });

  it('en el alta las dos en null no valen: borrar es de la edición', async () => {
    expect(
      await errores(CreateWarehouseV2Dto, {
        ...ALTA,
        latitude: null,
        longitude: null,
      }),
    ).toEqual(['latitude', 'longitude']);
  });

  it('la edición acepta las dos con número, las dos en null o ninguna', async () => {
    expect(await errores(UpdateWarehouseV2Dto, {})).toEqual([]);
    expect(await errores(UpdateWarehouseV2Dto, POSADAS)).toEqual([]);
    expect(
      await errores(UpdateWarehouseV2Dto, { latitude: null, longitude: null }),
    ).toEqual([]);
  });

  it.each([{ latitude: null }, { longitude: null }])(
    'una sola coordenada en null, sin la otra, es inválida (%p)',
    async (ubicacion) => {
      expect(await errores(UpdateWarehouseV2Dto, ubicacion)).toEqual([
        'latitude',
        'longitude',
      ]);
      expect(
        await errores(CreateWarehouseV2Dto, { ...ALTA, ...ubicacion }),
      ).toEqual(['latitude', 'longitude']);
    },
  );

  it.each([
    [{ latitude: -27.3671 }, 'longitude'],
    [{ longitude: -55.8961 }, 'latitude'],
    [{ latitude: -27.3671, longitude: null }, 'longitude'],
    [{ latitude: null, longitude: -55.8961 }, 'latitude'],
    [{ latitude: undefined, longitude: -55.8961 }, 'latitude'],
  ])('una sola coordenada es inválida (%p)', async (ubicacion, falta) => {
    expect(
      await errores(CreateWarehouseV2Dto, { ...ALTA, ...ubicacion }),
    ).toEqual([falta]);
  });

  it.each([
    [{ latitude: -90.0001, longitude: 0 }, 'latitude'],
    [{ latitude: 90.0001, longitude: 0 }, 'latitude'],
    [{ latitude: 0, longitude: -180.0001 }, 'longitude'],
    [{ latitude: 0, longitude: 180.0001 }, 'longitude'],
    [{ latitude: '-27.3', longitude: -55.8 }, 'latitude'],
    [{ latitude: Number.NaN, longitude: -55.8 }, 'latitude'],
    [{ latitude: -27.3, longitude: Number.POSITIVE_INFINITY }, 'longitude'],
  ])('fuera de rango o no numérica es inválida (%p)', async (u, campo) => {
    expect(await errores(UpdateWarehouseV2Dto, u)).toEqual([campo]);
  });

  it('acepta los extremos del rango', async () => {
    expect(
      await errores(UpdateWarehouseV2Dto, { latitude: -90, longitude: 180 }),
    ).toEqual([]);
    expect(
      await errores(UpdateWarehouseV2Dto, { latitude: 90, longitude: -180 }),
    ).toEqual([]);
  });

  it('la v1 no acepta la ubicación: su contrato no cambia', async () => {
    expect(await errores(CreateWarehouseDto, { ...ALTA, ...POSADAS })).toEqual(
      expect.arrayContaining(['latitude', 'longitude']),
    );
  });

  it('el mensaje de una sola coordenada se lee en castellano con la etiqueta del depósito', async () => {
    const pipe = crearValidationPipe();
    const error: unknown = await pipe
      .transform(
        { ...ALTA, latitude: -27.3671 },
        { type: 'body', metatype: CreateWarehouseV2Dto },
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(BadRequestException);
    const cuerpo = (error as BadRequestException).getResponse() as {
      message: string[];
    };
    expect(cuerpo.message).toContain(
      'Longitud del depósito: va junto con la latitud (mandá las dos o ninguna)',
    );
  });

  it.each([
    [
      { latitude: null },
      [
        'Latitud del depósito: va junto con la longitud (mandá las dos o ninguna)',
        'Longitud del depósito: va junto con la latitud (mandá las dos o ninguna)',
      ],
    ],
    [
      { longitude: null },
      [
        'Latitud del depósito: va junto con la longitud (mandá las dos o ninguna)',
        'Longitud del depósito: va junto con la latitud (mandá las dos o ninguna)',
      ],
    ],
    [
      { latitude: 91, longitude: 0 },
      ['Latitud del depósito: tiene que estar entre -90 y 90'],
    ],
  ])(
    'la edición explica el motivo de cada campo (%p)',
    async (cuerpo, mensajes) => {
      const error: unknown = await crearValidationPipe()
        .transform(cuerpo, { type: 'body', metatype: UpdateWarehouseV2Dto })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(BadRequestException);
      const r = (error as BadRequestException).getResponse() as {
        message: string[];
      };
      expect(r.message).toEqual(mensajes);
    },
  );
});
