import { BadRequestException, ValidationPipe } from '@nestjs/common';
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
  it('Mercado Pago y efectivo son obligatorios: el cuerpo vacío o con un faltante es inválido', async () => {
    expect(await camposInvalidos({})).toEqual([
      'cashPercentage',
      'mercadoPagoPercentage',
    ]);
    expect(await camposInvalidos({ cashPercentage: 0 })).toEqual([
      'mercadoPagoPercentage',
    ]);
    expect(
      await camposInvalidos({ mercadoPagoPercentage: null, cashPercentage: 0 }),
    ).toEqual(['mercadoPagoPercentage']);
  });

  it('acepta los valores por omisión y los límites', async () => {
    expect(
      await camposInvalidos({ mercadoPagoPercentage: 10, cashPercentage: 0 }),
    ).toEqual([]);
    expect(
      await camposInvalidos({
        mercadoPagoPercentage: 0.01,
        cashPercentage: 7.5,
      }),
    ).toEqual([]);
  });

  it.each([
    ['mercadoPagoPercentage', -1],
    ['mercadoPagoPercentage', 30.01],
    ['cashPercentage', 31],
    ['cashPercentage', 10.123],
    ['cashPercentage', '5'],
  ])('rechaza %s = %p', async (campo, valor) => {
    expect(
      await camposInvalidos({
        mercadoPagoPercentage: 10,
        cashPercentage: 0,
        [campo]: valor,
      }),
    ).toContain(campo);
  });

  it('transferPercentage ya no se admite: 400 PAYMENT_METHOD_NOT_ACCEPTED', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true });
    const error: unknown = await pipe
      .transform(
        {
          transferPercentage: 10,
          mercadoPagoPercentage: 10,
          cashPercentage: 0,
        },
        { type: 'body', metatype: PaymentSurchargeConfigDto },
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      statusCode: 400,
      code: 'PAYMENT_METHOD_NOT_ACCEPTED',
      message:
        'La distribuidora ya no acepta transferencias. Elegí efectivo o Mercado Pago.',
    });
  });
});
