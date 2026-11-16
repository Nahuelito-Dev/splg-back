/**
 * Reglas de los datos bancarios de una distribuidora (CBU, alias, titular).
 * Puras: las usan el DTO, el servicio y la restricción de la base, que arma su
 * expresión SQL desde acá para que las tres capas digan lo mismo.
 */

/** Alias bancario: 6 a 20 caracteres entre letras, números, punto y guion. */
export const ALIAS_BANCARIO_REGEX = /^[A-Za-z0-9.-]{6,20}$/;

/** Mismo patrón para Postgres (`~`). */
export const ALIAS_BANCARIO_SQL = '^[A-Za-z0-9.-]{6,20}$';

export const MAX_TITULAR_BANCARIO = 120;
export const MIN_TITULAR_BANCARIO = 2;

/** Ponderadores de los dígitos 1 a 7 (bloque de entidad y sucursal). */
const PESOS_BLOQUE_1 = [7, 1, 3, 9, 7, 1, 3] as const;
/** Ponderadores de los dígitos 9 a 21 (número de cuenta). */
const PESOS_BLOQUE_2 = [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3] as const;

function digitoVerificador(suma: number): number {
  return (10 - (suma % 10)) % 10;
}

/**
 * CBU: 22 dígitos. Los dígitos 8 y 22 son verificadores del primer bloque
 * (entidad + sucursal) y del segundo (cuenta).
 */
export function esCbuValido(cbu: string): boolean {
  if (!/^[0-9]{22}$/.test(cbu)) return false;
  const d = [...cbu].map(Number);
  const suma1 = PESOS_BLOQUE_1.reduce((a, peso, i) => a + peso * d[i], 0);
  const suma2 = PESOS_BLOQUE_2.reduce((a, peso, i) => a + peso * d[8 + i], 0);
  return (
    digitoVerificador(suma1) === d[7] && digitoVerificador(suma2) === d[21]
  );
}

/** La misma validación del CBU como expresión de un CHECK de Postgres. */
export function cbuValidoSql(columna: string): string {
  const suma = (pesos: readonly number[], desde: number): string =>
    pesos
      .map((peso, i) => `substr(${columna}, ${desde + i}, 1)::int * ${peso}`)
      .join(' + ');
  return (
    `${columna} IS NULL OR CASE WHEN ${columna} ~ '^[0-9]{22}$' THEN ` +
    `(10 - ((${suma(PESOS_BLOQUE_1, 1)}) % 10)) % 10 = substr(${columna}, 8, 1)::int ` +
    `AND (10 - ((${suma(PESOS_BLOQUE_2, 9)}) % 10)) % 10 = substr(${columna}, 22, 1)::int ` +
    `ELSE false END`
  );
}
