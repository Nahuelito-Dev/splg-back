import { ReglaDeEnvaseError } from './errors/cylinder-rule.errors';

/** Largo máximo del serial grabado en el envase. */
export const SERIAL_MAXIMO = 100;

/**
 * Forma canónica del serial: sin espacios en los bordes y en mayúsculas, así
 * `ab-1 ` y `AB-1` son el mismo envase (la base lo garantiza con
 * `UQ_cylinder_serial_normalizado`, que es `upper(btrim(serial))`). Se recortan
 * sólo los espacios (U+0020), igual que `btrim` de SQL: JS y la base tienen que
 * normalizar exactamente igual.
 */
export function normalizarSerial(serial: string): string {
  return serial.replace(/^ +| +$/g, '').toUpperCase();
}

/** El serial en su forma canónica; vacío no es un serial. */
export function serialCanonico(serial: string): string {
  const normalizado = normalizarSerial(serial);
  if (normalizado.trim() === '') {
    throw new ReglaDeEnvaseError('El serial no puede estar vacío');
  }
  return normalizado;
}
