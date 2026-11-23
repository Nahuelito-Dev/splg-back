import Decimal from 'decimal.js';
import { PaymentMethod } from '../order/entities/order.entity';

/**
 * Recargo (en %) que se suma al total del pedido según el medio de pago. Se
 * guarda por distribuidora en `module_config` (proceso `payment_surcharges`).
 */
export interface PaymentSurchargeSettings {
  /** Recargo por Mercado Pago, en %. */
  mercadoPagoPercentage: number;
  /** Recargo por efectivo, en %. */
  cashPercentage: number;
}

export const SURCHARGE_PERCENTAGE_MIN = 0;
export const SURCHARGE_PERCENTAGE_MAX = 30;

/** Los recargos que se configuran. */
export const CLAVES_DE_RECARGO: ReadonlyArray<keyof PaymentSurchargeSettings> =
  ['mercadoPagoPercentage', 'cashPercentage'];

/** Lo que regía antes de que fuera configurable: +10 % online, efectivo sin recargo. */
export function paymentSurchargeSettingsPorDefecto(): PaymentSurchargeSettings {
  return {
    mercadoPagoPercentage: 10,
    cashPercentage: 0,
  };
}

/** ¿Es un porcentaje válido? Entre 0 y 30, con hasta 2 decimales. */
export function esPorcentajeDeRecargo(valor: unknown): valor is number {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return false;
  if (valor < SURCHARGE_PERCENTAGE_MIN || valor > SURCHARGE_PERCENTAGE_MAX) {
    return false;
  }
  return new Decimal(valor).decimalPlaces() <= 2;
}

/**
 * Los parámetros guardados, leídos con defensa: una clave ausente o inválida
 * cae al valor de omisión en vez de romper una cotización.
 */
export function paymentSurchargeSettingsDesde(
  params: Record<string, unknown> | null,
): PaymentSurchargeSettings {
  const base = paymentSurchargeSettingsPorDefecto();
  if (!params) return base;
  const leido = { ...base };
  for (const clave of CLAVES_DE_RECARGO) {
    const valor = params[clave];
    if (esPorcentajeDeRecargo(valor)) leido[clave] = valor;
  }
  return leido;
}

export function sonLosDeOmisionRecargo(
  settings: PaymentSurchargeSettings,
): boolean {
  const base = paymentSurchargeSettingsPorDefecto();
  return CLAVES_DE_RECARGO.every((k) => settings[k] === base[k]);
}

/**
 * El % del medio de pago. Cuenta corriente (`account`) no se cobra en el acto:
 * no lleva recargo.
 */
export function porcentajeDelMedio(
  settings: PaymentSurchargeSettings,
  method: PaymentMethod,
): number {
  switch (method) {
    case PaymentMethod.MERCADOPAGO:
      return settings.mercadoPagoPercentage;
    case PaymentMethod.CASH:
      return settings.cashPercentage;
    default:
      return 0;
  }
}
