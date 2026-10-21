import { BadRequestException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { PaymentMethod } from '../entities/order.entity';

const aPesos = (monto: Decimal.Value): string =>
  new Decimal(monto).toDecimalPlaces(2).toFixed(2);

/** El total como lo guarda la base: 2 decimales, mitades hacia arriba. */
export const totalDeBase = (total: Decimal.Value): Decimal =>
  new Decimal(total).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/**
 * ¿El total (ya con 2 decimales) quedó por debajo de la seña ya cobrada? Una sola
 * comparación para la cotización y la edición, así no discrepan en el borde
 * (100.089 se guarda como 100.09).
 */
export const totalBajoLaSenaPagada = (
  total: Decimal.Value,
  senaPagada: Decimal.Value,
): boolean => totalDeBase(total).lt(senaPagada);

/**
 * La seña de una reserva no puede superar el total del pedido (con recargos de
 * zona y de medio de pago): sería cobrarle de más al cliente de antemano.
 * Igual al total sí se acepta. 400 con el monto de cada uno.
 */
export function assertSenaNoSuperaTotal(
  deposit: Decimal.Value,
  total: Decimal.Value,
): void {
  const totalRedondeado = totalDeBase(total);
  if (new Decimal(deposit).gt(totalRedondeado)) {
    throw new BadRequestException(
      `La seña ($${aPesos(deposit)}) no puede superar el total del pedido ($${aPesos(totalRedondeado)})`,
    );
  }
}

/**
 * Una reserva que se paga con MercadoPago se activa cuando la pasarela aprueba
 * la seña, y no se confirma a mano: sin seña no hay checkout ni forma de
 * activarla, y expiraría. Exige una seña mayor a cero (400).
 */
export function assertSenaConMercadoPago(
  paymentMethod: PaymentMethod,
  deposit: Decimal.Value | null | undefined,
): void {
  if (
    paymentMethod === PaymentMethod.MERCADOPAGO &&
    !totalDeBase(deposit ?? 0).gt(0)
  ) {
    throw new BadRequestException(
      'Una reserva con MercadoPago necesita una seña mayor a cero: la seña se cobra online y activa la reserva',
    );
  }
}
