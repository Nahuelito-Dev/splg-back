import {
  etiquetaDeEntidad,
  etiquetaDeValorParaMostrar,
} from '../../common/validation/etiquetas';
import type { Celda, Columna, TipoDeColumna } from '../export.types';

function columna(tipo: TipoDeColumna) {
  return <F>(
    titulo: string,
    valor: (fila: F) => Celda,
    ancho?: number,
  ): Columna<F> => ({ titulo, tipo, valor, ancho });
}

export const texto = columna('texto');
export const codigo = columna('codigo');
export const entero = columna('entero');
export const decimal = columna('decimal');
export const moneda = columna('moneda');
export const fecha = columna('fecha');
export const fechaHora = columna('fechaHora');
export const booleano = columna('booleano');

/**
 * Columna de texto cuyo valor es una opción del código (`active`, `driver`,
 * `delivered`…): sale con el texto que ve la persona. `campo` es el nombre del
 * campo en el código y permite una etiqueta propia de ese campo (`campo:valor`).
 * Lo que no figura en el diccionario sale tal cual.
 */
export const opcion = <F>(
  titulo: string,
  campo: string,
  valor: (fila: F) => Celda,
  ancho?: number,
): Columna<F> =>
  texto<F>(
    titulo,
    (fila) => {
      const celda = valor(fila);
      return typeof celda === 'string'
        ? (etiquetaDeValorParaMostrar(celda, campo) ?? celda)
        : celda;
    },
    ancho,
  );

/** Columna con el nombre que ve la persona de una entidad de la auditoría. */
export const entidad = <F>(
  titulo: string,
  valor: (fila: F) => string | null | undefined,
  ancho?: number,
): Columna<F> =>
  texto<F>(
    titulo,
    (fila) => {
      const nombre = valor(fila);
      return nombre == null ? nombre : (etiquetaDeEntidad(nombre) ?? nombre);
    },
    ancho,
  );
