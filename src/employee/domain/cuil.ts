/** Prefijos que ARCA asigna a las personas humanas. */
const PREFIJOS_VALIDOS = ['20', '23', '24', '27'];
const FACTORES = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/** Deja sólo los dígitos: acepta `20-12345678-6` y `20 12345678 6`. */
export function normalizarCuil(valor: string): string {
  return valor.replace(/[-\s]/g, '');
}

/**
 * ¿Es un CUIL/CUIT de persona humana bien formado? Once dígitos, prefijo
 * 20/23/24/27 y dígito verificador módulo 11 (el que daría 10 no existe: ARCA
 * lo resuelve cambiando el prefijo, así que esos números no son válidos).
 */
export function esCuilValido(cuil: string): boolean {
  if (!/^\d{11}$/.test(cuil)) return false;
  if (!PREFIJOS_VALIDOS.includes(cuil.slice(0, 2))) return false;

  const suma = FACTORES.reduce(
    (acc, factor, i) => acc + factor * Number(cuil[i]),
    0,
  );
  const resto = suma % 11;
  const verificador = resto === 0 ? 0 : 11 - resto;
  return verificador < 10 && verificador === Number(cuil[10]);
}
