import {
  BadRequestException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Workbook } from 'exceljs';
import { ImportFormat } from '../domain/import.enums';
import { detectarFormato, leerArchivo, textoDeCelda } from './lector-de-tabla';

async function xlsx(filas: unknown[][]): Promise<Buffer> {
  const libro = new Workbook();
  const hoja = libro.addWorksheet('Hoja 1');
  filas.forEach((f) => hoja.addRow(f));
  return Buffer.from(await libro.xlsx.writeBuffer());
}

describe('lector-de-tabla', () => {
  describe('detectarFormato', () => {
    it('xlsx: extensión y firma de zip', async () => {
      expect(detectarFormato('a.XLSX', await xlsx([['a']]))).toBe(
        ImportFormat.XLSX,
      );
    });

    it('csv: extensión y contenido de texto', () => {
      expect(detectarFormato('a.csv', Buffer.from('a;b'))).toBe(
        ImportFormat.CSV,
      );
    });

    it.each([
      ['viejo.xls', Buffer.from('a;b')],
      ['foto.png', Buffer.from('a;b')],
      ['sinextension', Buffer.from('a;b')],
    ])('%s es 415', (nombre, contenido) => {
      expect(() => detectarFormato(nombre, contenido)).toThrow(
        UnsupportedMediaTypeException,
      );
    });

    it('un .csv que en realidad es un zip es 415', () => {
      expect(() =>
        detectarFormato('a.csv', Buffer.from([0x50, 0x4b, 3, 4])),
      ).toThrow(UnsupportedMediaTypeException);
    });

    it('un .xlsx que no es un zip es 415', () => {
      expect(() => detectarFormato('a.xlsx', Buffer.from('a;b'))).toThrow(
        UnsupportedMediaTypeException,
      );
    });

    it('un .csv con bytes nulos (binario) es 415', () => {
      expect(() =>
        detectarFormato('a.csv', Buffer.from([0x61, 0, 0x62])),
      ).toThrow(UnsupportedMediaTypeException);
    });
  });

  describe('leerArchivo', () => {
    it('lee un .xlsx con el número de fila real y todo en texto', async () => {
      const contenido = await xlsx([
        ['Tipo', 'Precio'],
        ['10 kg', 12500.5],
        [],
        ['15 kg', 20000],
      ]);
      expect(await leerArchivo('a.xlsx', contenido)).toEqual([
        { fila: 1, celdas: ['Tipo', 'Precio'] },
        { fila: 2, celdas: ['10 kg', '12500,5'] },
        { fila: 4, celdas: ['15 kg', '20000'] },
      ]);
    });

    it('lee un .csv con ; y BOM', async () => {
      const contenido = Buffer.from('﻿Tipo;Precio\r\n10 kg;12500,50\r\n');
      expect(await leerArchivo('a.csv', contenido)).toEqual([
        { fila: 1, celdas: ['Tipo', 'Precio'] },
        { fila: 2, celdas: ['10 kg', '12500,50'] },
      ]);
    });

    it('un .xlsx dañado es 400', async () => {
      const dañado = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
      await expect(leerArchivo('a.xlsx', dañado)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('textoDeCelda', () => {
    it('convierte cada tipo de valor de Excel', () => {
      expect(textoDeCelda(null)).toBe('');
      expect(textoDeCelda(undefined)).toBe('');
      expect(textoDeCelda('  hola ')).toBe('hola');
      expect(textoDeCelda(30715123456)).toBe('30715123456');
      expect(textoDeCelda(true)).toBe('true');
      expect(textoDeCelda(new Date('2026-10-27T00:00:00Z'))).toBe('2026-10-27');
      expect(textoDeCelda({ richText: [{ text: 'a' }, { text: 'b ' }] })).toBe(
        'ab',
      );
      expect(textoDeCelda({ formula: 'A1+1', result: 5 })).toBe('5');
      expect(textoDeCelda({ text: 'sitio', hyperlink: 'http://x' })).toBe(
        'sitio',
      );
      expect(textoDeCelda({ error: '#N/A' })).toBe('');
    });
  });
});
