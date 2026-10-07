import { esSecreto, VALOR_OCULTO } from './audit-exclusions';

const MAX_TEXTO = 2000;

/** Un campo que cambió, ya en texto. */
export interface CambioDeCampo {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

/**
 * El valor normalizado a texto: fechas ISO, booleanos `true/false`, números y
 * decimales tal cual, objetos (jsonb, puntos) como JSON. `null` y `undefined`
 * son null. Sin truncar: sirve para comparar.
 */
export function textoDe(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  if (valor instanceof Date) {
    return Number.isNaN(valor.getTime()) ? null : valor.toISOString();
  }
  if (typeof valor === 'string') return valor;
  if (typeof valor === 'number' || typeof valor === 'bigint') {
    return String(valor);
  }
  if (typeof valor === 'boolean') return valor ? 'true' : 'false';
  if (Buffer.isBuffer(valor)) return '[binario]';
  try {
    return JSON.stringify(valor);
  } catch {
    return '[no serializable]';
  }
}

const NUMERICO = /^-?\d+(\.\d+)?$/;

/**
 * Mismo valor aunque cambie la forma: `10.00` (decimal) y `10` (number). Sólo
 * en columnas numéricas: un teléfono `03764123456` no es el número 3764123456.
 */
function iguales(
  a: string | null,
  b: string | null,
  numerico: boolean,
): boolean {
  if (a === b) return true;
  if (a === null || b === null || !numerico) return false;
  return NUMERICO.test(a) && NUMERICO.test(b) && Number(a) === Number(b);
}

function truncar(texto: string | null): string | null {
  if (texto === null || texto.length <= MAX_TEXTO) return texto;
  return `${texto.slice(0, MAX_TEXTO)}…`;
}

/**
 * El cambio de un campo, o null si el valor es el mismo. Los secretos se
 * registran como `[oculto]`, sin dejar rastro del valor. `numerico` activa la
 * comparación numérica (decimal contra number) para columnas numéricas.
 */
export function cambioDeCampo(
  field: string,
  anterior: unknown,
  nuevo: unknown,
  numerico = false,
): CambioDeCampo | null {
  const oldText = textoDe(anterior);
  const newText = textoDe(nuevo);
  if (iguales(oldText, newText, numerico)) return null;
  if (esSecreto(field)) {
    return {
      field,
      oldValue: oldText === null ? null : VALOR_OCULTO,
      newValue: newText === null ? null : VALOR_OCULTO,
    };
  }
  return { field, oldValue: truncar(oldText), newValue: truncar(newText) };
}
