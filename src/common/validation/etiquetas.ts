import { ETIQUETAS_CAMPOS } from './etiquetas-campos';
import { ETIQUETAS_ENTIDADES } from './etiquetas-entidades';
import { ETIQUETAS_POR_CLASE, SINGULARES } from './etiquetas-por-clase';
import { ETIQUETAS_VALORES } from './etiquetas-valores';

/**
 * Lo que ve la persona en los mensajes de error: etiquetas de campo y de valor
 * de enum en castellano, nunca los nombres del código.
 */

/** Etiqueta de un campo; `clase` permite una etiqueta propia de ese DTO. */
export function etiquetaDeCampo(
  campo: string,
  clase?: string,
): string | undefined {
  return (
    (clase ? buscar(ETIQUETAS_POR_CLASE, `${clase}.${campo}`) : undefined) ??
    buscar(ETIQUETAS_CAMPOS, campo)
  );
}

/** Búsqueda en un diccionario sin tropezar con `constructor`, `toString` o `__proto__`. */
export function buscar(
  diccionario: Readonly<Record<string, string>>,
  clave: string,
): string | undefined {
  return Object.hasOwn(diccionario, clave) ? diccionario[clave] : undefined;
}

/** Texto de un valor de enum, con la primera letra en minúscula para usarlo dentro de una frase. */
export function etiquetaDeValor(
  valor: string,
  campo?: string,
): string | undefined {
  const etiqueta =
    (campo ? buscar(ETIQUETAS_VALORES, `${campo}:${valor}`) : undefined) ??
    buscar(ETIQUETAS_VALORES, valor);
  return etiqueta === undefined ? undefined : enFrase(etiqueta);
}

/** Texto de un valor de enum tal como se muestra solo (con mayúscula inicial), p. ej. en una columna. */
export function etiquetaDeValorParaMostrar(
  valor: string,
  campo?: string,
): string | undefined {
  return (
    (campo ? buscar(ETIQUETAS_VALORES, `${campo}:${valor}`) : undefined) ??
    buscar(ETIQUETAS_VALORES, valor)
  );
}

/** El texto de un valor de enum para meter en un mensaje; sin texto en el diccionario queda el valor. */
export function valorLegible(valor: string, campo?: string): string {
  return etiquetaDeValorParaMostrar(valor, campo)?.toLowerCase() ?? valor;
}

/** Nombre que ve la persona de una entidad de la auditoría (`Claim` → «Reclamo»). */
export function etiquetaDeEntidad(entidad: string): string | undefined {
  return buscar(ETIQUETAS_ENTIDADES, entidad);
}

/** «Al día» → «al día»; las siglas y marcas («VTV», «iOS», «CSV») se respetan. */
function enFrase(texto: string): string {
  const [primera, segunda] = texto;
  if (
    segunda !== undefined &&
    segunda === segunda.toUpperCase() &&
    segunda !== segunda.toLowerCase()
  ) {
    return texto;
  }
  return primera.toLowerCase() + texto.slice(1);
}

/**
 * Ruta legible de un campo anidado: `items.1.quantity` → «Ítem 2 · Cantidad».
 * Un segmento sin etiqueta se omite: nunca se muestra un nombre interno.
 */
export function rutaLegible(
  segmentos: readonly string[],
  clase?: string,
): string {
  const partes: string[] = [];
  segmentos.forEach((segmento, i) => {
    if (/^\d+$/.test(segmento)) {
      const anterior = segmentos[i - 1];
      if (partes.length === 0 || anterior === undefined) return;
      const singular = buscar(SINGULARES, anterior);
      if (singular) partes[partes.length - 1] = singular;
      partes[partes.length - 1] += ` ${Number(segmento) + 1}`;
      return;
    }
    const etiqueta = etiquetaDeCampo(segmento, i === 0 ? clase : undefined);
    if (etiqueta) partes.push(etiqueta);
  });
  return partes.join(' · ');
}
