import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegistrarClienteDto } from './registrar-usuario.dto';

const base = {
  email: 'ana@correo.com',
  password: 'Ejemplo2026x',
  full_name: 'Ana Pérez',
  phone_number: '+5493764000000',
};
const GARRAFA = '3f2c9a3e-8a0b-4a4e-9a52-6a1d7c6f5b10';

const errores = async (cuerpo: object) =>
  (
    await validate(plainToInstance(RegistrarClienteDto, { ...base, ...cuerpo }))
  ).map((e) => e.property);

describe('RegistrarClienteDto · consumo declarado (CU-143)', () => {
  it('el consumo es opcional: sin él el registro es válido', async () => {
    await expect(errores({})).resolves.toEqual([]);
  });

  it('acepta una declaración completa y la convierte en su clase', async () => {
    const dto = plainToInstance(RegistrarClienteDto, {
      ...base,
      consumption: { cylinderTypeId: GARRAFA, quantityPerMonth: 2 },
    });

    expect(await validate(dto)).toEqual([]);
    expect(dto.consumption?.constructor.name).toBe('DeclareConsumptionDto');
  });

  it.each([0, -1, 1001, 1.234])(
    'rechaza una cantidad por mes inválida (%s)',
    async (quantityPerMonth) => {
      await expect(
        errores({ consumption: { cylinderTypeId: GARRAFA, quantityPerMonth } }),
      ).resolves.toEqual(['consumption']);
    },
  );

  it('rechaza un tipo de garrafa que no es un uuid', async () => {
    await expect(
      errores({ consumption: { cylinderTypeId: 'x', quantityPerMonth: 1 } }),
    ).resolves.toEqual(['consumption']);
  });
});

describe('RegistrarClienteDto · política de contraseña', () => {
  it.each([
    'Abcde12',
    'abcdef12',
    'Abcdefgh',
    'ABCDEF12',
    'Test1234',
    `A1${'x'.repeat(127)}`,
  ])('rechaza %s con 400 sobre password', async (password) => {
    await expect(errores({ password })).resolves.toEqual(['password']);
  });

  it('acepta espacios y caracteres cualquiera', async () => {
    await expect(errores({ password: 'Mi clave ñ#9 ok' })).resolves.toEqual([]);
  });
});
