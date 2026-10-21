import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateGasCylinderDto } from './create-gascylinder.dto';
import { UpdateGasCylinderDto } from './update-gascylinder.dto';

const propiedadesInvalidas = async <T extends object>(
  clase: new () => T,
  cuerpo: object,
): Promise<string[]> =>
  (await validate(plainToInstance(clase, cuerpo))).map((e) => e.property);

const valido = { type: 'Garrafa 10 kg', weight: 10, price: 15000 };

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
