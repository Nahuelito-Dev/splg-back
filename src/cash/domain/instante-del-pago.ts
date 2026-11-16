import { BadRequestException } from '@nestjs/common';
import { instanteDelPago } from '../../insurance/domain/payment-date';
import { rutaLegible } from '../../common/validation/etiquetas';

/** Margen para el reloj del cliente al registrar «cuándo se pagó» (5 minutos). */
const MARGEN_FECHA_FUTURA_MS = 5 * 60 * 1000;

/**
 * El instante de un pago o un cobro del cuerpo (`paidAt`, `receivedAt`): una
 * fecha sin hora es ese día en hora argentina. 400 si es inválido o futuro.
 */
export function instanteValido(texto: string, campo: string): Date {
  const instante = instanteDelPago(texto);
  if (Number.isNaN(instante.getTime())) {
    throw new BadRequestException(
      `${rutaLegible(campo.split('.'))}: no es una fecha válida`,
    );
  }
  if (instante.getTime() > Date.now() + MARGEN_FECHA_FUTURA_MS) {
    throw new BadRequestException(
      `${rutaLegible(campo.split('.'))}: no puede ser posterior a hoy`,
    );
  }
  return instante;
}
