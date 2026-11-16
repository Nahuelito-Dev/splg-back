/** Prefijos de CUIT: personas humanas (20, 23, 24, 27) y jurídicas (30, 33, 34). */
const PREFIJOS_VALIDOS = ['20', '23', '24', '27', '30', '33', '34'];
const FACTORES = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/** Deja sólo los dígitos: acepta `30-71234567-1` y `30 71234567 1`. */
export function normalizarCuit(valor: string): string {
  return valor.replace(/[-\s]/g, '');
}

/**
 * ¿Es un CUIT bien formado? Once dígitos, prefijo de persona humana o jurídica
 * y dígito verificador módulo 11 (cuando daría 10 el número no existe: ARCA lo
 * resuelve cambiando el prefijo).
 */
export function esCuitValido(cuit: string): boolean {
  if (!/^\d{11}$/.test(cuit)) return false;
  if (!PREFIJOS_VALIDOS.includes(cuit.slice(0, 2))) return false;
  const suma = FACTORES.reduce(
    (acc, factor, i) => acc + factor * Number(cuit[i]),
    0,
  );
  const resto = suma % 11;
  const verificador = resto === 0 ? 0 : 11 - resto;
  return verificador < 10 && verificador === Number(cuit[10]);
}
