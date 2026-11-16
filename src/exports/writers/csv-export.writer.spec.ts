import { Readable } from 'node:stream';
import type { Celda, Encabezado } from '../export.types';
import {
  BOM_UTF8,
  encabezadoCsv,
  filasCsv,
  streamCsv,
} from './csv-export.writer';

const enc = (titulo: string, tipo: Encabezado['tipo']): Encabezado => ({
  titulo,
  tipo,
  ancho: 10,
});

function deLotes(...lotes: Celda[][][]): AsyncIterable<Celda[][]> {
  return Readable.from(lotes);
}

async function leer(stream: AsyncIterable<unknown>): Promise<string> {
  let salida = '';
  for await (const chunk of stream) salida += String(chunk);
  return salida;
}

describe('CSV de exporte', () => {
  it('arranca con BOM UTF-8 y separa los encabezados con punto y coma', () => {
    const cabecera = encabezadoCsv([
      enc('Nombre', 'texto'),
      enc('Total', 'moneda'),
    ]);

    expect(cabecera).toBe(`${BOM_UTF8}Nombre;Total\n`);
  });

  it('escribe los números con coma decimal y la moneda con dos decimales', () => {
    const encabezados = [
      enc('Litros', 'decimal'),
      enc('Importe', 'moneda'),
      enc('Unidades', 'entero'),
    ];

    expect(filasCsv(encabezados, [[12.5, 1500, 3]])).toBe('12,5;1500,00;3\n');
  });

  it('convierte los números que llegan como texto (SQL crudo)', () => {
    expect(filasCsv([enc('Saldo', 'moneda')], [['1234.5']])).toBe('1234,50\n');
  });

  it('deja vacío lo que no es un número', () => {
    expect(filasCsv([enc('Saldo', 'moneda')], [['abc']])).toBe('\n');
  });

  it('escapa las celdas que una planilla leería como fórmula', () => {
    const filas = filasCsv(
      [
        enc('A', 'texto'),
        enc('B', 'texto'),
        enc('C', 'texto'),
        enc('D', 'texto'),
      ],
      [['=SUMA(A1)', '+54', '-cmd', '@usuario']],
    );

    expect(filas).toBe("'=SUMA(A1);'+54;'-cmd;'@usuario\n");
  });

  it('no escapa un importe negativo: es un número, no una fórmula', () => {
    expect(filasCsv([enc('Dif', 'moneda')], [[-5]])).toBe('-5,00\n');
  });

  it('entrecomilla lo que tiene separador, comillas o saltos de línea', () => {
    const filas = filasCsv(
      [enc('A', 'texto'), enc('B', 'texto')],
      [['a;b', 'dijo "hola"\nchau']],
    );

    expect(filas).toBe('"a;b";"dijo ""hola""\nchau"\n');
  });

  it('entrecomilla el texto con coma o tab: en una planilla con coma no se parte en celdas', () => {
    const filas = filasCsv(
      [enc('A', 'texto'), enc('B', 'texto')],
      [['Perez, =cmd|x', 'a\t=1']],
    );

    expect(filas).toBe('"Perez, =cmd|x";"a\t=1"\n');
  });

  it('escribe un código como fórmula de texto para que no pierda los ceros', () => {
    expect(filasCsv([enc('Tel', 'codigo')], [['0341-4123']])).toBe(
      '"=""0341-4123"""\n',
    );
  });

  it('escribe las fechas en hora argentina', () => {
    const filas = filasCsv(
      [enc('Día', 'fecha'), enc('Alta', 'fechaHora'), enc('Vence', 'fecha')],
      [
        [
          new Date('2026-10-28T01:30:00.000Z'),
          new Date('2026-10-28T01:30:00.000Z'),
          '2026-11-02',
        ],
      ],
    );

    expect(filas).toBe('2026-10-27;2026-10-27 22:30;2026-11-02\n');
  });

  it('escribe Sí y No', () => {
    expect(
      filasCsv([enc('A', 'booleano'), enc('B', 'booleano')], [[true, false]]),
    ).toBe('Sí;No\n');
  });

  it('arma el archivo entero con un chunk por lote', async () => {
    const encabezados = [enc('N', 'entero')];

    const texto = await leer(
      streamCsv(encabezados, deLotes([[1], [2]], [[3]])),
    );

    expect(texto).toBe(`${BOM_UTF8}N\n1\n2\n3\n`);
  });
});
