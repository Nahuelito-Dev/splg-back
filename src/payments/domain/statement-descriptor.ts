/** Lo más largo que se manda como `statement_descriptor`: el límite varía según la marca de la tarjeta, 13 entra en todas. */
export const LARGO_MAXIMO_DEL_DESCRIPTOR = 13;

export const DESCRIPTOR_POR_DEFECTO = 'SPLG';

/**
 * Nombre que el comprador ve en el resumen de su tarjeta, a partir del de la
 * distribuidora: sin tildes ni símbolos, en mayúsculas y de hasta 13 caracteres.
 * Un nombre que no deja nada (vacío, sólo símbolos) cae en `SPLG`.
 */
export function descriptorDeResumen(nombre?: string | null): string {
  const limpio = (nombre ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .slice(0, LARGO_MAXIMO_DEL_DESCRIPTOR)
    .trim();
  return limpio || DESCRIPTOR_POR_DEFECTO;
}
