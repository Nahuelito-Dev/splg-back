import { BadRequestException } from '@nestjs/common';
import { ColumnaDeImportacion } from '../domain/import.types';
import { FilaDeArchivo } from './lector-de-tabla';
import { armarFilas, normalizarEncabezado } from './tabla-importada';

const COLUMNAS: ColumnaDeImportacion[] = [
  { key: 'type', header: 'Tipo', ejemplo: '10 kg', obligatoria: true },
  { key: 'weight', header: 'Peso (kg)', ejemplo: '10', obligatoria: true },
  { key: 'notes', header: 'Descripción', ejemplo: '', obligatoria: false },
];

const archivo = (...filas: string[][]): FilaDeArchivo[] =>
  filas.map((celdas, i) => ({ fila: i + 1, celdas }));

describe('tabla-importada', () => {
  it('normalizarEncabezado ignora acentos, mayúsculas y signos', () => {
    expect(normalizarEncabezado(' Descripción ')).toBe('descripcion');
    expect(normalizarEncabezado('Peso (kg)')).toBe('pesokg');
  });

  it('una fila con celdas de más (coma decimal en un CSV con comas) rechaza el archivo', () => {
    expect(() =>
      armarFilas(
        archivo(
          ['Tipo', 'Peso (kg)', 'Descripción'],
          ['10 kg', '10', 'ok'],
          ['15 kg', '12', '5', 'algo'],
        ),
        COLUMNAS,
      ),
    ).toThrow('La fila 3 tiene más celdas que el encabezado');
  });

  it('con más de diez filas así, lista las primeras diez', () => {
    const malas = Array.from({ length: 12 }, () => [
      '10 kg',
      '10',
      'x',
      'de más',
    ]);
    expect(() =>
      armarFilas(
        archivo(['Tipo', 'Peso (kg)', 'Descripción'], ...malas),
        COLUMNAS,
      ),
    ).toThrow('Las filas 2, 3, 4, 5, 6, 7, 8, 9, 10, 11… tienen más celdas');
  });

  it('celdas vacías a la derecha del encabezado no son un error', () => {
    const filas = armarFilas(
      archivo(['Tipo', 'Peso (kg)'], ['10 kg', '10', '', '']),
      COLUMNAS,
    );
    expect(filas).toHaveLength(1);
  });

  it('arma las filas por clave, con el número real de fila', () => {
    const filas = armarFilas(
      archivo(['TIPO', 'peso kg'], ['10 kg', '10'], ['15 kg', '15']),
      COLUMNAS,
    );
    expect(filas).toEqual([
      { fila: 2, celdas: { type: '10 kg', weight: '10', notes: '' } },
      { fila: 3, celdas: { type: '15 kg', weight: '15', notes: '' } },
    ]);
  });

  it('acepta el nombre de la propiedad como encabezado y cualquier orden', () => {
    const filas = armarFilas(
      archivo(['weight', 'type', 'notes'], ['10', '10 kg', 'x']),
      COLUMNAS,
    );
    expect(filas[0].celdas).toEqual({
      weight: '10',
      type: '10 kg',
      notes: 'x',
    });
  });

  it('saltea las filas vacías sin correr la numeración', () => {
    const filas = armarFilas(
      archivo(['Tipo', 'Peso (kg)'], ['', ''], ['10 kg', '10']),
      COLUMNAS,
    );
    expect(filas.map((f) => f.fila)).toEqual([3]);
  });

  it('una columna opcional que no está en el archivo queda vacía en todas las filas', () => {
    const filas = armarFilas(
      archivo(['Tipo', 'Peso (kg)'], ['10 kg', '10']),
      COLUMNAS,
    );
    expect(filas[0].celdas.notes).toBe('');
  });

  it('una celda que falta en la fila queda vacía', () => {
    const filas = armarFilas(
      archivo(['Tipo', 'Peso (kg)'], ['10 kg']),
      COLUMNAS,
    );
    expect(filas[0].celdas.weight).toBe('');
  });

  it('un archivo vacío es 400', () => {
    expect(() => armarFilas([], COLUMNAS)).toThrow('El archivo está vacío');
  });

  it('un encabezado desconocido es 400 y lo nombra', () => {
    expect(() =>
      armarFilas(
        archivo(['Tipo', 'Peso (kg)', 'Color'], ['a', '1', 'rojo']),
        COLUMNAS,
      ),
    ).toThrow('Columnas que no existen en la plantilla: Color');
  });

  it('falta una columna obligatoria: 400 y la nombra', () => {
    expect(() => armarFilas(archivo(['Tipo'], ['10 kg']), COLUMNAS)).toThrow(
      'Faltan columnas obligatorias: Peso (kg)',
    );
  });

  it('una columna repetida es 400', () => {
    expect(() =>
      armarFilas(
        archivo(['Tipo', 'tipo', 'Peso (kg)'], ['a', 'b', '1']),
        COLUMNAS,
      ),
    ).toThrow('Hay una columna repetida en el encabezado');
  });

  it('sin filas de datos es 400', () => {
    expect(() => armarFilas(archivo(['Tipo', 'Peso (kg)']), COLUMNAS)).toThrow(
      BadRequestException,
    );
  });

  it('más de 5.000 filas es 400; 5.000 pasa', () => {
    const datos = (n: number) =>
      archivo(
        ['Tipo', 'Peso (kg)'],
        ...Array.from({ length: n }, () => ['a', '1']),
      );
    expect(armarFilas(datos(5000), COLUMNAS)).toHaveLength(5000);
    expect(() => armarFilas(datos(5001), COLUMNAS)).toThrow(
      'El archivo tiene 5001 filas: el máximo es 5000',
    );
  });
});
