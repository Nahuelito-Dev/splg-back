import {
  BadRequestException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Workbook, CellValue } from 'exceljs';
import { Readable } from 'stream';
import { ImportFormat } from '../domain/import.enums';
import { decodificarCsv, parsearCsv } from './csv-parser';

/** Una fila del archivo: su número en la hoja (el encabezado es la 1) y sus celdas en texto. */
export interface FilaDeArchivo {
  fila: number;
  celdas: string[];
}

const FIRMA_ZIP = [0x50, 0x4b, 0x03, 0x04];

/**
 * El formato sale de la extensión y se confirma con el contenido: un `.xlsx`
 * tiene que ser un zip y un `.csv` no puede serlo ni traer bytes nulos.
 */
export function detectarFormato(
  nombre: string,
  contenido: Buffer,
): ImportFormat {
  const extension = nombre.toLowerCase().split('.').pop();
  const esZip = FIRMA_ZIP.every((byte, i) => contenido[i] === byte);
  if (extension === 'xlsx' && esZip) return ImportFormat.XLSX;
  if (extension === 'csv' && !esZip && !contenido.includes(0)) {
    return ImportFormat.CSV;
  }
  throw new UnsupportedMediaTypeException(
    'El archivo tiene que ser un .xlsx o un .csv (y su contenido tiene que coincidir con la extensión)',
  );
}

/** Convierte lo que guarda una celda de Excel en el texto que vería el usuario. */
export function textoDeCelda(valor: CellValue | undefined): string {
  if (valor === null || valor === undefined) return '';
  if (typeof valor === 'string') return valor.trim();
  // Un número de Excel sale con coma decimal: «12.125» se leería como doce mil.
  if (typeof valor === 'number') return String(valor).replace('.', ',');
  if (typeof valor === 'boolean') {
    return String(valor);
  }
  if (valor instanceof Date) return valor.toISOString().slice(0, 10);
  if ('richText' in valor) {
    return valor.richText
      .map((r) => r.text)
      .join('')
      .trim();
  }
  if ('formula' in valor || 'sharedFormula' in valor) {
    return textoDeCelda(valor.result as CellValue | undefined);
  }
  if ('hyperlink' in valor) return String(valor.text ?? '').trim();
  if ('error' in valor) return '';
  return '';
}

async function leerXlsx(contenido: Buffer): Promise<FilaDeArchivo[]> {
  const libro = new Workbook();
  try {
    await libro.xlsx.read(Readable.from([contenido]));
  } catch {
    throw new BadRequestException(
      'No se pudo leer el .xlsx: el archivo está dañado o no es un libro de Excel',
    );
  }
  const hoja = libro.worksheets[0];
  if (!hoja) throw new BadRequestException('El libro no tiene hojas');
  const filas: FilaDeArchivo[] = [];
  hoja.eachRow({ includeEmpty: false }, (row, numero) => {
    const celdas: string[] = [];
    for (let c = 1; c <= row.cellCount; c++) {
      celdas.push(textoDeCelda(row.getCell(c).value));
    }
    filas.push({ fila: numero, celdas });
  });
  return filas;
}

function leerCsv(contenido: Buffer): FilaDeArchivo[] {
  return parsearCsv(decodificarCsv(contenido)).map((celdas, i) => ({
    fila: i + 1,
    celdas: celdas.map((c) => c.trim()),
  }));
}

/** Todas las filas de la primera hoja (o del CSV), con su número real. */
export function leerArchivo(
  nombre: string,
  contenido: Buffer,
): Promise<FilaDeArchivo[]> {
  return detectarFormato(nombre, contenido) === ImportFormat.XLSX
    ? leerXlsx(contenido)
    : Promise.resolve(leerCsv(contenido));
}
