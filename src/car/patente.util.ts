/**
 * La patente se guarda en mayúsculas, sin espacios ni guiones: "ab 123-cd" y
 * "AB123CD" son el mismo vehículo para la regla de unicidad y las búsquedas.
 */
export function normalizarPatente(patente: string): string {
  return patente.replace(/[\s-]/g, '').toUpperCase();
}

/** Formato argentino: AAA123 (anterior) o AA123AA (Mercosur), ya normalizada. */
export const PATENTE_ARGENTINA =
  /^([A-Z]{3}[0-9]{3}|[A-Z]{2}[0-9]{3}[A-Z]{2})$/;
