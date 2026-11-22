import { BadRequestException } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { CODIGOS_DE_ERROR, conCodigo } from '../../common/errors/con-codigo';
import { PaymentMethod } from '../entities/order.entity';

export const MENSAJE_MEDIO_DE_PAGO_NO_ACEPTADO =
  'La distribuidora ya no acepta transferencias. Elegí efectivo o Mercado Pago.';

/**
 * Medios con los que se puede dar de alta un pedido nuevo. La transferencia
 * dejó de aceptarse: los pedidos que ya la tienen se siguen leyendo y cobrando
 * (el valor sigue en el enum), pero ninguno nuevo puede quedar con ella.
 */
export function esMedioDePagoAceptado(
  medio: PaymentMethod | string | null | undefined,
): boolean {
  return medio !== PaymentMethod.TRANSFER;
}

/**
 * El medio que una sugerencia guardada con la transferencia pasa a ofrecer:
 * efectivo. Cualquier otro medio queda igual.
 */
export function medioVigenteDeLaSugerencia(
  medio: PaymentMethod,
): PaymentMethod {
  return medio === PaymentMethod.TRANSFER ? PaymentMethod.CASH : medio;
}

/**
 * Edición de un pedido: pasar a la transferencia es 400, pero un pedido viejo
 * que ya la tiene la conserva si el medio no cambia.
 */
export function assertCambioDeMedioAceptado(
  medioActual: PaymentMethod,
  medioNuevo: PaymentMethod | null | undefined,
): void {
  if (medioNuevo && medioNuevo !== medioActual) {
    assertMedioDePagoAceptado(medioNuevo);
  }
}

/** 400 `PAYMENT_METHOD_NOT_ACCEPTED` si el medio elegido es la transferencia. */
export function assertMedioDePagoAceptado(
  medio: PaymentMethod | string | null | undefined,
): void {
  if (!esMedioDePagoAceptado(medio)) {
    throw conCodigo(
      BadRequestException,
      400,
      MENSAJE_MEDIO_DE_PAGO_NO_ACEPTADO,
      CODIGOS_DE_ERROR.PAYMENT_METHOD_NOT_ACCEPTED,
    );
  }
}

/** Validación de entrada: conserva el 400 y el código de dominio antes del caso de uso. */
export const RechazarTransferenciaEnDto = () =>
  Transform(({ value }: { value: unknown }) => {
    assertMedioDePagoAceptado(
      value as PaymentMethod | string | null | undefined,
    );
    return value;
  });

/**
 * Validación de entrada del recargo de transferencia: la configuración ya no la
 * admite, así que mandarla (con cualquier valor) es 400 con el mismo código.
 */
export const RechazarRecargoDeTransferenciaEnDto = () =>
  Transform(() => {
    throw conCodigo(
      BadRequestException,
      400,
      MENSAJE_MEDIO_DE_PAGO_NO_ACEPTADO,
      CODIGOS_DE_ERROR.PAYMENT_METHOD_NOT_ACCEPTED,
    );
  });
