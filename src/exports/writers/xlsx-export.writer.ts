import type { Writable } from 'node:stream';
import { stream as streamDeExcel } from 'exceljs';
import type { Celda, Encabezado, TipoDeColumna } from '../export.types';
import {
  aDiaDePlanilla,
  aInstanteDePlanilla,
  aNumero,
  aTextoDeBooleano,
} from '../formato';

/** Una celda de texto de Excel admite hasta 32.767 caracteres. */
const MAXIMO_DE_TEXTO = 32_000;

export const NOMBRE_DE_HOJA = 'Exporte';

const FORMATO_DE_CELDA: Record<TipoDeColumna, string> = {
  texto: '@',
  codigo: '@',
  entero: '0',
  decimal: '#,##0.00##',
  moneda: '"$" #,##0.00',
  fecha: 'dd/mm/yyyy',
  fechaHora: 'dd/mm/yyyy hh:mm',
  booleano: '@',
};

export function formatoDeCelda(tipo: TipoDeColumna): string {
  return FORMATO_DE_CELDA[tipo];
}

/** El valor tal como va a la celda de Excel, según el tipo de la columna. */
export function valorDeCelda(
  valor: Celda,
  tipo: TipoDeColumna,
): string | number | Date | null {
  if (valor === null || valor === undefined || valor === '') return null;
  switch (tipo) {
    case 'entero':
    case 'decimal':
    case 'moneda':
      return aNumero(valor);
    case 'fecha':
      return aDiaDePlanilla(valor);
    case 'fechaHora':
      return aInstanteDePlanilla(valor);
    case 'booleano':
      return aTextoDeBooleano(valor);
    case 'codigo':
    case 'texto':
      return String(valor).slice(0, MAXIMO_DE_TEXTO);
  }
}

/**
 * Escribe el libro (una hoja) en `destino` a medida que llegan los lotes, sin
 * armarlo entero en memoria. Cierra `destino` al terminar; si algo falla lo
 * destruye con el error.
 */
export async function escribirXlsx(
  destino: Writable,
  encabezados: readonly Encabezado[],
  lotes: AsyncIterable<Celda[][]>,
  signal?: AbortSignal,
): Promise<void> {
  const cortado = (): boolean => destino.destroyed || signal?.aborted === true;
  try {
    const libro = new streamDeExcel.xlsx.WorkbookWriter({
      stream: destino,
      useStyles: true,
      useSharedStrings: false,
    });
    const hoja = libro.addWorksheet(NOMBRE_DE_HOJA, {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    hoja.columns = encabezados.map((e) => ({ width: e.ancho }));
    hoja.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: encabezados.length },
    };

    const titulos = hoja.addRow(encabezados.map((e) => e.titulo));
    titulos.font = { bold: true };
    titulos.alignment = { vertical: 'middle' };
    titulos.commit();

    for await (const lote of lotes) {
      if (cortado()) break;
      for (const fila of lote) {
        const row = hoja.addRow(
          encabezados.map((e, i) => valorDeCelda(fila[i], e.tipo)),
        );
        encabezados.forEach((e, i) => {
          row.getCell(i + 1).numFmt = formatoDeCelda(e.tipo);
        });
        row.commit();
      }
    }

    if (cortado()) {
      // El cliente se fue: cerrar el libro quedaría esperando a un destino muerto.
      destino.destroy();
      return;
    }
    hoja.commit();
    await libro.commit();
  } catch (error) {
    destino.destroy(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}
