/**
 * Etiquetas de las conversaciones de la bandeja (C2/C3, tanda 7c): cada
 * empresa arma las suyas (nombre corto y un color de una paleta fija) y las
 * pone en sus conversaciones para ordenarse y para las métricas. Las ve sólo
 * el personal: al cliente y al chofer nunca les llegan.
 */

/** Los colores que se pueden elegir: claves, no hex (el panel las pinta con su paleta). */
export const COLORES_DE_ETIQUETA = [
  'gray',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'indigo',
  'purple',
  'pink',
] as const;

export type ColorDeEtiqueta = (typeof COLORES_DE_ETIQUETA)[number];

export const LARGO_DEL_NOMBRE_DE_ETIQUETA = 30;

/** Etiquetas vigentes por empresa. */
export const TOPE_DE_ETIQUETAS = 50;

/** Etiquetas por conversación. */
export const TOPE_DE_ETIQUETAS_POR_CONVERSACION = 5;

/** Caracteres de control y separadores de línea: el nombre va en una sola línea. */
const NO_IMPRIMIBLES = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** El nombre como se guarda: sin espacios en las puntas y con los de adentro de a uno. */
export function nombreDeEtiqueta(nombre: string): string {
  return nombre.trim().replace(/\s+/g, ' ');
}

/** De 1 a 30 caracteres (contados como letras, no en UTF-16) en una sola línea. */
export function nombreDeEtiquetaValido(nombre: string): boolean {
  if (NO_IMPRIMIBLES.test(nombre)) return false;
  const largo = [...nombreDeEtiqueta(nombre)].length;
  return largo >= 1 && largo <= LARGO_DEL_NOMBRE_DE_ETIQUETA;
}

/**
 * La clave con que se compara si dos nombres son el mismo: sin mayúsculas ni
 * tildes («Envíos» = «ENVIOS»). La base usa la misma regla
 * (`chat_label_key`, con `unaccent`) en su único parcial.
 */
export function claveDelNombre(nombre: string): string {
  return nombreDeEtiqueta(nombre)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}
