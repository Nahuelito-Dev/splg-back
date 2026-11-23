import { BadRequestException } from '@nestjs/common';
import { PaymentMethod } from '../entities/order.entity';
import {
  assertCambioDeMedioAceptado,
  assertMedioDePagoAceptado,
  esMedioDePagoAceptado,
  medioVigenteDeLaSugerencia,
  MENSAJE_MEDIO_DE_PAGO_NO_ACEPTADO,
} from './medio-de-pago-aceptado';

const cuerpoDe = (fn: () => void): Record<string, unknown> => {
  try {
    fn();
  } catch (e) {
    return (e as BadRequestException).getResponse() as Record<string, unknown>;
  }
  throw new Error('no lanzó');
};

describe('medio de pago aceptado', () => {
  it('la transferencia no se acepta; efectivo, Mercado Pago y cuenta corriente sí', () => {
    expect(esMedioDePagoAceptado(PaymentMethod.TRANSFER)).toBe(false);
    expect(esMedioDePagoAceptado('transfer')).toBe(false);
    for (const m of [
      PaymentMethod.CASH,
      PaymentMethod.MERCADOPAGO,
      PaymentMethod.ACCOUNT,
    ]) {
      expect(esMedioDePagoAceptado(m)).toBe(true);
    }
  });

  it('assertMedioDePagoAceptado: 400 con mensaje en castellano y code en inglés', () => {
    expect(cuerpoDe(() => assertMedioDePagoAceptado('transfer'))).toEqual({
      statusCode: 400,
      message:
        'La distribuidora ya no acepta transferencias. Elegí efectivo o Mercado Pago.',
      error: 'Bad Request',
      code: 'PAYMENT_METHOD_NOT_ACCEPTED',
    });
    expect(MENSAJE_MEDIO_DE_PAGO_NO_ACEPTADO).toContain('Mercado Pago');
    expect(() => assertMedioDePagoAceptado(PaymentMethod.CASH)).not.toThrow();
  });

  it('en una edición, pasar a transferencia es 400 y conservarla no', () => {
    expect(() =>
      assertCambioDeMedioAceptado(PaymentMethod.CASH, PaymentMethod.TRANSFER),
    ).toThrow(BadRequestException);
    expect(() =>
      assertCambioDeMedioAceptado(
        PaymentMethod.TRANSFER,
        PaymentMethod.TRANSFER,
      ),
    ).not.toThrow();
    expect(() =>
      assertCambioDeMedioAceptado(PaymentMethod.TRANSFER, undefined),
    ).not.toThrow();
    expect(() =>
      assertCambioDeMedioAceptado(PaymentMethod.TRANSFER, PaymentMethod.CASH),
    ).not.toThrow();
  });

  it('una sugerencia guardada con transferencia pasa a efectivo; lo demás queda igual', () => {
    expect(medioVigenteDeLaSugerencia(PaymentMethod.TRANSFER)).toBe(
      PaymentMethod.CASH,
    );
    expect(medioVigenteDeLaSugerencia(PaymentMethod.MERCADOPAGO)).toBe(
      PaymentMethod.MERCADOPAGO,
    );
  });
});
