import { randomInt, timingSafeEqual } from 'crypto';

/**
 * Código secreto de la prueba de entrega (dominio puro, sin dependencias de
 * NestJS/TypeORM — testeable en aislamiento).
 *
 * Se genera al ACEPTAR el pedido. Lo ve el cliente en su app (v3) y se lo dice
 * al chofer cuando llega; el chofer lo escribe. El chofer NO lo conoce de
 * antemano: por eso funciona como prueba de que el cliente recibió el pedido.
 */

/**
 * 6 dígitos (000000 a 999999), el código que el cliente puede tipear si no
 * puede escanear. Con `crypto.randomInt` (no `Math.random`). 10^6 combinaciones
 * serían pocas sin freno: por eso el pedido se bloquea a los
 * `MAX_INTENTOS_CODIGO_ENTREGA` códigos incorrectos y el chofer genera uno
 * nuevo. Los pedidos viejos conservan su código (10 hexadecimales).
 */
export function generateDeliveryCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** Códigos incorrectos del cliente tras los cuales el código del pedido queda bloqueado. */
export const MAX_INTENTOS_CODIGO_ENTREGA = 5;

/**
 * Comparación de tiempo constante (evita timing attacks) entre el código
 * guardado en el pedido y el que envía el cliente. `expected` puede ser
 * null (pedido sin código aún) → siempre false.
 */
export function compareDeliveryCode(
  expected: string | null | undefined,
  provided: string | null | undefined,
): boolean {
  if (!expected || !provided) return false;

  const expectedBuf = Buffer.from(expected.toUpperCase());
  const providedBuf = Buffer.from(provided.toUpperCase());

  // timingSafeEqual exige buffers del mismo largo; si difieren, el código ya
  // es inválido (comparar contra sí mismo no filtra info útil del secreto).
  if (expectedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(expectedBuf, providedBuf);
}

/** Por qué se rechazó un código de entrega (campo `code` del 400 de `confirm-delivery`). */
export enum DeliveryCodeError {
  /** No tiene la forma de un código de entrega: se tipeó mal. */
  FORMATO = 'DELIVERY_CODE_FORMATO',
  /** Es un código válido, pero de otro pedido en camino del mismo cliente. */
  OTRO_PEDIDO = 'DELIVERY_CODE_OTRO_PEDIDO',
  /** Tiene la forma correcta, pero no es el de este pedido. */
  INCORRECTO = 'DELIVERY_CODE_INCORRECTO',
  /** Se agotaron los intentos: el chofer tiene que generar un código nuevo. */
  BLOQUEADO = 'DELIVERY_CODE_BLOQUEADO',
  /** El pedido todavía no tiene código para mostrar (no está aceptado ni en camino). */
  SIN_CODIGO = 'ORDER_WITHOUT_DELIVERY_CODE',
  /** La entrega sólo se confirma con el pedido en camino. */
  NO_EN_CAMINO = 'ORDER_NOT_ON_THE_WAY',
}

const FORMATO_DEL_CODIGO = /^[0-9A-Za-z]{4,12}$/;

/** Forma plausible de un código de entrega: alfanumérico de 4 a 12 . */
export function tieneFormatoDeCodigo(code: string): boolean {
  return FORMATO_DEL_CODIGO.test(code);
}

const CODIGO_DE_SEIS_DIGITOS = /^\d{6}$/;

/** El código que genera el sistema: exactamente 6 dígitos (lo que escribe el chofer). */
export function esCodigoDeSeisDigitos(code: string): boolean {
  return CODIGO_DE_SEIS_DIGITOS.test(code);
}
