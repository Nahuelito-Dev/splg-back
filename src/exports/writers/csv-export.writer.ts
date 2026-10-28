import { Readable } from 'node:stream';
import type { Celda, Encabezado, TipoDeColumna } from '../export.types';
import {
  aDia,
  aDiaYHora,
  aNumero,
  aTextoDeBooleano,
  neutralizarFormula,
} from '../formato';

/** En es-AR Excel separa columnas con `;` porque la coma es el decimal. */
export const SEPARADOR_CSV = ';';
/** Para que Excel reconozca UTF-8 (tildes, ñ). */
export const BOM_UTF8 = '﻿';

/**
 * Con comillas también si lleva coma o tab: en una planilla con otro separador
 * (`,`) el texto se partiría en celdas y la segunda podría empezar con `=`.
 */
const necesitaComillas = (texto: string): boolean => /[",;\t\r\n]/.test(texto);

const entrecomillar = (texto: string): string =>
  necesitaComillas(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;

/** Un valor que se lee como texto aunque parezca número: `="0341-4123"`. */
const comoCodigo = (texto: string): string =>
  entrecomillar(`="${texto.replace(/"/g, '""')}"`);

function celdaCsv(valor: Celda, tipo: TipoDeColumna): string {
  if (valor === null || valor === undefined || valor === '') return '';
  switch (tipo) {
    case 'entero':
    case 'decimal': {
      const n = aNumero(valor);
      return n === null ? '' : String(n).replace('.', ',');
    }
    case 'moneda': {
      const n = aNumero(valor);
      return n === null ? '' : n.toFixed(2).replace('.', ',');
    }
    case 'fecha':
      return aDia(valor) ?? '';
    case 'fechaHora':
      return aDiaYHora(valor) ?? '';
    case 'booleano':
      return aTextoDeBooleano(valor);
    case 'codigo':
      return comoCodigo(String(valor));
    case 'texto':
      return entrecomillar(neutralizarFormula(String(valor)));
  }
}

export function encabezadoCsv(encabezados: readonly Encabezado[]): string {
  return (
    BOM_UTF8 +
    encabezados
      .map((e) => entrecomillar(neutralizarFormula(e.titulo)))
      .join(SEPARADOR_CSV) +
    '\n'
  );
}

export function filasCsv(
  encabezados: readonly Encabezado[],
  filas: readonly Celda[][],
): string {
  let salida = '';
  for (const fila of filas) {
    salida +=
      encabezados.map((e, i) => celdaCsv(fila[i], e.tipo)).join(SEPARADOR_CSV) +
      '\n';
  }
  return salida;
}

/** El CSV como un stream: encabezado y después un chunk por lote. */
export function streamCsv(
  encabezados: readonly Encabezado[],
  lotes: AsyncIterable<Celda[][]>,
): Readable {
  async function* chunks(): AsyncGenerator<string> {
    yield encabezadoCsv(encabezados);
    for await (const lote of lotes) {
      yield filasCsv(encabezados, lote);
    }
  }
  return Readable.from(chunks(), { objectMode: false });
}
