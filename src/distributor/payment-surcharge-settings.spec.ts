import { PaymentMethod } from '../order/entities/order.entity';
import {
  esPorcentajeDeRecargo,
  paymentSurchargeSettingsDesde,
  paymentSurchargeSettingsPorDefecto,
  porcentajeDelMedio,
  sonLosDeOmisionRecargo,
} from './payment-surcharge-settings';

describe('recargo por medio de pago: parámetros', () => {
  it('por omisión rige lo de siempre: transferencia 10, Mercado Pago 10, efectivo 0', () => {
    expect(paymentSurchargeSettingsPorDefecto()).toEqual({
      transferPercentage: 10,
      mercadoPagoPercentage: 10,
      cashPercentage: 0,
    });
    expect(paymentSurchargeSettingsDesde(null)).toEqual(
      paymentSurchargeSettingsPorDefecto(),
    );
  });

  it.each([
    [0, true],
    [30, true],
    [7.5, true],
    [12.34, true],
    [0.01, true],
    [30.01, false],
    [-0.01, false],
    [12.345, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    ['10', false],
    [null, false],
  ])('esPorcentajeDeRecargo(%p) = %p', (valor, esperado) => {
    expect(esPorcentajeDeRecargo(valor)).toBe(esperado);
  });

  it('lee lo guardado y una clave ausente o inválida cae a su valor por omisión', () => {
    expect(
      paymentSurchargeSettingsDesde({
        transferPercentage: 7.5,
        mercadoPagoPercentage: 99,
        cashPercentage: 'x',
      }),
    ).toEqual({
      transferPercentage: 7.5,
      mercadoPagoPercentage: 10,
      cashPercentage: 0,
    });
  });

  it('cada medio toma su propio porcentaje y la cuenta corriente no lleva recargo', () => {
    const s = {
      transferPercentage: 5,
      mercadoPagoPercentage: 12.5,
      cashPercentage: 2,
    };
    expect(porcentajeDelMedio(s, PaymentMethod.TRANSFER)).toBe(5);
    expect(porcentajeDelMedio(s, PaymentMethod.MERCADOPAGO)).toBe(12.5);
    expect(porcentajeDelMedio(s, PaymentMethod.CASH)).toBe(2);
    expect(porcentajeDelMedio(s, PaymentMethod.ACCOUNT)).toBe(0);
  });

  it('sonLosDeOmisionRecargo distingue lo editado', () => {
    expect(sonLosDeOmisionRecargo(paymentSurchargeSettingsPorDefecto())).toBe(
      true,
    );
    expect(
      sonLosDeOmisionRecargo({
        ...paymentSurchargeSettingsPorDefecto(),
        cashPercentage: 1,
      }),
    ).toBe(false);
  });
});
