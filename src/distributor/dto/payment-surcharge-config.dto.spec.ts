import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PaymentSurchargeConfigDto } from './payment-surcharge-config.dto';

async function camposInvalidos(cuerpo: Record<string, unknown>) {
  const errores = await validate(
    plainToInstance(PaymentSurchargeConfigDto, cuerpo),
  );
  return errores.map((e) => e.property).sort();
}

describe('PaymentSurchargeConfigDto', () => {
  it('los tres son obligatorios: el cuerpo vacío o con un faltante es inválido', async () => {
    expect(await camposInvalidos({})).toEqual([
      'cashPercentage',
      'mercadoPagoPercentage',
      'transferPercentage',
    ]);
    expect(
      await camposInvalidos({ transferPercentage: 10, cashPercentage: 0 }),
    ).toEqual(['mercadoPagoPercentage']);
    expect(
      await camposInvalidos({
        transferPercentage: 10,
        mercadoPagoPercentage: null,
        cashPercentage: 0,
      }),
    ).toEqual(['mercadoPagoPercentage']);
  });

  it('acepta los valores por omisión y los límites', async () => {
    expect(
      await camposInvalidos({
        transferPercentage: 10,
        mercadoPagoPercentage: 10,
        cashPercentage: 0,
      }),
    ).toEqual([]);
    expect(
      await camposInvalidos({
        transferPercentage: 30,
        mercadoPagoPercentage: 0.01,
        cashPercentage: 7.5,
      }),
    ).toEqual([]);
  });

  it.each([
    ['transferPercentage', 30.01],
    ['mercadoPagoPercentage', -1],
    ['cashPercentage', 31],
    ['transferPercentage', 10.123],
    ['cashPercentage', '5'],
  ])('rechaza %s = %p', async (campo, valor) => {
    expect(
      await camposInvalidos({
        transferPercentage: 10,
        mercadoPagoPercentage: 10,
        cashPercentage: 0,
        [campo]: valor,
      }),
    ).toContain(campo);
  });
});
