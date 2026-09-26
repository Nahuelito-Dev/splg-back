/**
 * Copia `datos` sin las claves que valen `undefined`. En una actualización
 * parcial lo que no vino en el cuerpo no se toca: sin esto, mapear un DTO a la
 * entidad campo por campo dejaría en `undefined` todo lo que no se mandó.
 */
export function sinIndefinidos<T extends object>(datos: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(datos).filter(([, valor]) => valor !== undefined),
  ) as Partial<T>;
}
