import { randomBytes, timingSafeEqual } from 'crypto';

/**
 * Código secreto de la prueba de entrega con QR (dominio puro, sin
 * dependencias de NestJS/TypeORM — testeable en aislamiento).
 *
 * Se genera al ACEPTAR el pedido y viaja embebido en el QR que el chofer
 * muestra en su app. El cliente NO lo conoce de antemano: solo lo obtiene
 * escaneando ese QR físico, por eso funciona como prueba de que el chofer
 * estuvo presente en la entrega.
 */

/**
 * 10 caracteres hexadecimales (mayúsculas, legibles en un QR chico).
 * 16^10 combinaciones ≈ 1.1 * 10^12: adivinarlo a fuerza bruta es inviable,
 * más todavía porque solo es válido mientras el pedido está ON_THE_WAY.
 */
export function generateDeliveryCode(): string {
  return randomBytes(5).toString('hex').toUpperCase();
}

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

  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);

  // timingSafeEqual exige buffers del mismo largo; si difieren, el código ya
  // es inválido (comparar contra sí mismo no filtra info útil del secreto).
  if (expectedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(expectedBuf, providedBuf);
}
