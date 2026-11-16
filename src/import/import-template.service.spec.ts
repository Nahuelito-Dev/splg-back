import { Workbook } from 'exceljs';
import { Readable } from 'stream';
import { ImportFormat } from './domain/import.enums';
import { ColumnaDeImportacion } from './domain/import.types';
import { ImportTemplateService } from './import-template.service';
import { leerArchivo } from './parsing/lector-de-tabla';
import { armarFilas } from './parsing/tabla-importada';

const COLUMNAS: ColumnaDeImportacion[] = [
  { key: 'type', header: 'Tipo', ejemplo: '10 kg', obligatoria: true },
  { key: 'price', header: 'Precio', ejemplo: '12500,50', obligatoria: true },
  {
    key: 'description',
    header: 'Descripción',
    ejemplo: 'Dice "hola"; chau',
    obligatoria: false,
  },
];

describe('ImportTemplateService', () => {
  const service = new ImportTemplateService();

  it('la plantilla xlsx trae los encabezados en castellano y una fila de ejemplo', async () => {
    const plantilla = await service.generar(COLUMNAS, ImportFormat.XLSX);
    expect(plantilla.extension).toBe('xlsx');
    expect(plantilla.tipo).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    const libro = new Workbook();
    await libro.xlsx.read(Readable.from([plantilla.contenido]));
    const hoja = libro.worksheets[0];
    expect(hoja.getRow(1).values).toEqual([
      undefined,
      'Tipo',
      'Precio',
      'Descripción',
    ]);
    expect(hoja.getRow(2).values).toEqual([
      undefined,
      '10 kg',
      '12500,50',
      'Dice "hola"; chau',
    ]);
    expect(hoja.rowCount).toBe(2);
  });

  it('la plantilla csv va con ; y BOM, y escapa lo que lo necesita', async () => {
    const plantilla = await service.generar(COLUMNAS, ImportFormat.CSV);
    expect(plantilla.extension).toBe('csv');
    expect(plantilla.tipo).toBe('text/csv; charset=utf-8');
    expect([...plantilla.contenido.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(plantilla.contenido.toString('utf-8')).toBe(
      '﻿Tipo;Precio;Descripción\r\n10 kg;12500,50;"Dice ""hola""; chau"\r\n',
    );
  });

  it.each([
    ['xlsx', 'plantilla.xlsx', ImportFormat.XLSX],
    ['csv', 'plantilla.csv', ImportFormat.CSV],
  ])(
    'la plantilla %s se vuelve a leer con el lector de importación',
    async (_n, nombre, formato) => {
      const plantilla = await service.generar(COLUMNAS, formato);
      const filas = armarFilas(
        await leerArchivo(nombre, plantilla.contenido),
        COLUMNAS,
      );
      expect(filas).toEqual([
        {
          fila: 2,
          celdas: {
            type: '10 kg',
            price: '12500,50',
            description: 'Dice "hola"; chau',
          },
        },
      ]);
    },
  );
});
