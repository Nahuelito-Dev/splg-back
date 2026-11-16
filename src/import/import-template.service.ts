import { Injectable } from '@nestjs/common';
import { Workbook } from 'exceljs';
import { ImportFormat } from './domain/import.enums';
import { ColumnaDeImportacion } from './domain/import.types';

export interface PlantillaGenerada {
  contenido: Buffer;
  tipo: string;
  extension: ImportFormat;
}

const TIPO_XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const TIPO_CSV = 'text/csv; charset=utf-8';

function celdaCsv(valor: string): string {
  return /[";\r\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor;
}

/** Arma la plantilla de un recurso: encabezados en castellano y una fila de ejemplo. */
@Injectable()
export class ImportTemplateService {
  async generar(
    columnas: ColumnaDeImportacion[],
    formato: ImportFormat,
  ): Promise<PlantillaGenerada> {
    return formato === ImportFormat.CSV
      ? this.csv(columnas)
      : this.xlsx(columnas);
  }

  /** Separador `;` y BOM: es lo que Excel en castellano abre sin romper las tildes. */
  private csv(columnas: ColumnaDeImportacion[]): PlantillaGenerada {
    const texto = [
      columnas.map((c) => celdaCsv(c.header)).join(';'),
      columnas.map((c) => celdaCsv(c.ejemplo)).join(';'),
    ].join('\r\n');
    return {
      contenido: Buffer.from(`\uFEFF${texto}\r\n`, 'utf-8'),
      tipo: TIPO_CSV,
      extension: ImportFormat.CSV,
    };
  }

  private async xlsx(
    columnas: ColumnaDeImportacion[],
  ): Promise<PlantillaGenerada> {
    const libro = new Workbook();
    const hoja = libro.addWorksheet('Importación');
    hoja.columns = columnas.map((c) => ({
      header: c.header,
      key: c.key,
      width: Math.max(c.header.length, c.ejemplo.length) + 4,
    }));
    hoja.getRow(1).font = { bold: true };
    hoja.addRow(Object.fromEntries(columnas.map((c) => [c.key, c.ejemplo])));
    const bytes = await libro.xlsx.writeBuffer();
    return {
      contenido: Buffer.from(bytes),
      tipo: TIPO_XLSX,
      extension: ImportFormat.XLSX,
    };
  }
}
