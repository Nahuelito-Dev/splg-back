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
