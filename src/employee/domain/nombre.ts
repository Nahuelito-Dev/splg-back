/** Partes de un apellido compuesto que se pegan al apellido: "De la Cruz". */
const PARTICULAS = new Set([
  'de',
  'del',
  'la',
  'las',
  'los',
  'da',
  'di',
  'van',
  'von',
  'san',
  'santa',
]);

const LARGO_MAXIMO = 80;
const SIN_NOMBRE = 'Sin nombre';
const SIN_APELLIDO = 'Sin apellido';

export interface NombreYApellido {
  firstName: string;
  lastName: string;
}

/**
 * Parte el nombre completo de un usuario ("Juan Carlos de la Cruz") en nombre y
 * apellido, a mejor esfuerzo: el apellido es la última palabra más las
 * partículas que la preceden ("de la Cruz"); lo demás es el nombre. Nunca
 * devuelve vacíos (las columnas son NOT NULL) y recorta a 80 caracteres.
 */
export function partirNombreCompleto(
  nombreCompleto: string | null | undefined,
): NombreYApellido {
  const palabras = (nombreCompleto ?? '').trim().split(/\s+/).filter(Boolean);
  if (palabras.length === 0) {
    return { firstName: SIN_NOMBRE, lastName: SIN_APELLIDO };
  }
  if (palabras.length === 1) {
    return { firstName: recortar(palabras[0]), lastName: SIN_APELLIDO };
  }

  let inicioDelApellido = palabras.length - 1;
  while (
    inicioDelApellido > 1 &&
    PARTICULAS.has(palabras[inicioDelApellido - 1].toLowerCase())
  ) {
    inicioDelApellido--;
  }
  return {
    firstName: recortar(palabras.slice(0, inicioDelApellido).join(' ')),
    lastName: recortar(palabras.slice(inicioDelApellido).join(' ')),
  };
}

function recortar(texto: string): string {
  return texto.slice(0, LARGO_MAXIMO);
}
