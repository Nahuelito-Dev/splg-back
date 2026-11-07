import { ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { crearValidationPipe } from '../../common/validation/validation-pipe';
import { CreateGasCylinderDto } from './create-gascylinder.dto';
import { UpdateGasCylinderDto } from './update-gascylinder.dto';

const propiedadesInvalidas = async <T extends object>(
  clase: new () => T,
  cuerpo: object,
): Promise<string[]> =>
  (await validate(plainToInstance(clase, cuerpo))).map((e) => e.property);

const valido = { type: 'Garrafa 10 kg', weight: 10, price: 15000 };

const mensajesDeValidacion = async (
  clase: new () => object,
  cuerpo: object,
): Promise<string[]> => {
  const pipe = crearValidationPipe();
  const metadata: ArgumentMetadata = { type: 'body', metatype: clase };
  try {
    await pipe.transform(cuerpo, metadata);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    const response = (error as BadRequestException).getResponse() as {
      message: string[];
    };
    return response.message;
  }
  return [];
};

describe('CreateGasCylinderDto', () => {
  it('un producto válido pasa', async () => {
    expect(await propiedadesInvalidas(CreateGasCylinderDto, valido)).toEqual(
      [],
    );
  });

  describe('type', () => {
    it.each(['', '   ', '\t'])('%j es 400 (en blanco)', async (type) => {
      expect(
        await propiedadesInvalidas(CreateGasCylinderDto, { ...valido, type }),
      ).toContain('type');
    });

    it('se recorta antes de guardarse', () => {
      const dto = plainToInstance(CreateGasCylinderDto, {
        ...valido,
        type: '  Garrafa 15 kg ',
      });
      expect(dto.type).toBe('Garrafa 15 kg');
    });

    it('también se valida al editar', async () => {
      expect(
        await propiedadesInvalidas(UpdateGasCylinderDto, { type: '  ' }),
      ).toContain('type');
    });
  });

  describe('price y weight', () => {
    it.each([
      ['price', 0],
      ['price', -5],
      ['price', 12.345],
      ['price', 10_000_001],
      ['weight', 0],
      ['weight', 10.123],
      ['weight', 1001],
    ])('%s = %p es 400', async (campo, valor) => {
      expect(
        await propiedadesInvalidas(CreateGasCylinderDto, {
          ...valido,
          [campo]: valor,
        }),
      ).toContain(campo);
    });

    it.each([
      ['price', 0.01],
      ['price', 10_000_000],
      ['price', 12999.99],
      ['weight', 0.5],
      ['weight', 1000],
      ['weight', 15],
    ])('%s = %p pasa', async (campo, valor) => {
      expect(
        await propiedadesInvalidas(CreateGasCylinderDto, {
          ...valido,
          [campo]: valor,
        }),
      ).toEqual([]);
    });
  });

  describe('container_price', () => {
    it.each([0, -5, 12.345, 10_000_001, 'texto'])(
      '%p es inválido',
      async (container_price) => {
        expect(
          await propiedadesInvalidas(CreateGasCylinderDto, {
            ...valido,
            container_price,
          }),
        ).toContain('container_price');
      },
    );

    it.each([0.01, 10_000_000, 106000])(
      '%p es válido',
      async (container_price) => {
        expect(
          await propiedadesInvalidas(CreateGasCylinderDto, {
            ...valido,
            container_price,
          }),
        ).toEqual([]);
      },
    );

    it('null es válido y ausente en PATCH no se valida', async () => {
      expect(
        await propiedadesInvalidas(CreateGasCylinderDto, {
          ...valido,
          container_price: null,
        }),
      ).toEqual([]);
      expect(await propiedadesInvalidas(UpdateGasCylinderDto, {})).toEqual([]);
    });

    it.each([
      [0, 'Precio del envase: tiene que ser un número positivo'],
      [
        12.345,
        'Precio del envase: tiene que ser un número válido (revisá la cantidad de decimales)',
      ],
      [10_000_001, 'Precio del envase: tiene que ser como máximo 10000000'],
      [
        'texto',
        'Precio del envase: tiene que ser un número válido (revisá la cantidad de decimales)',
      ],
    ])(
      'traduce %p al mensaje en castellano',
      async (container_price, mensaje) => {
        await expect(
          mensajesDeValidacion(CreateGasCylinderDto, {
            ...valido,
            container_price,
          }),
        ).resolves.toContain(mensaje);
      },
    );
  });

  describe('promociones', () => {
    const conPromo = (discountPercentage: number) => ({
      ...valido,
      promotions: [{ quantity: 3, discountPercentage }],
    });

    it.each([99, 50.5, 0.01])('un descuento de %p pasa', async (d) => {
      expect(
        await propiedadesInvalidas(CreateGasCylinderDto, conPromo(d)),
      ).toEqual([]);
    });

    it.each([100, 99.01, 0, -1, 10.123])(
      'un descuento de %p es 400 (el tope es 99 %% y 2 decimales)',
      async (d) => {
        expect(
          await propiedadesInvalidas(CreateGasCylinderDto, conPromo(d)),
        ).toContain('promotions');
      },
    );
  });
});
