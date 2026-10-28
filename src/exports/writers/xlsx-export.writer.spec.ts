import { PassThrough, Readable } from 'node:stream';
import { Workbook } from 'exceljs';
import type { Celda, Encabezado } from '../export.types';
import {
  escribirXlsx,
  formatoDeCelda,
  NOMBRE_DE_HOJA,
  valorDeCelda,
} from './xlsx-export.writer';

const encabezados: Encabezado[] = [
  { titulo: 'Cliente', tipo: 'texto', ancho: 20 },
  { titulo: 'Total', tipo: 'moneda', ancho: 14 },
  { titulo: 'Unidades', tipo: 'entero', ancho: 10 },
  { titulo: 'Alta', tipo: 'fechaHora', ancho: 18 },
  { titulo: 'Vence', tipo: 'fecha', ancho: 12 },
  { titulo: 'Activo', tipo: 'booleano', ancho: 8 },
];

function deLotes(...lotes: Celda[][][]): AsyncIterable<Celda[][]> {
  return Readable.from(lotes);
}

async function generar(lotes: AsyncIterable<Celda[][]>): Promise<Workbook> {
  const salida = new PassThrough();
  const partes: Buffer[] = [];
  salida.on('data', (parte: Buffer) => partes.push(parte));
  const terminado = new Promise<void>((resolve, reject) => {
    salida.on('end', resolve);
    salida.on('error', reject);
  });
  await escribirXlsx(salida, encabezados, lotes);
  await terminado;
  const libro = new Workbook();
  await libro.xlsx.load(
    Buffer.concat(partes) as unknown as Parameters<Workbook['xlsx']['load']>[0],
  );
  return libro;
}

describe('Excel de exporte', () => {
  it('escribe una hoja con los encabezados en negrita y las filas de todos los lotes', async () => {
    const libro = await generar(
      deLotes(
        [
          [
            'Ana',
            1500.5,
            2,
            new Date('2026-10-28T01:30:00.000Z'),
            '2026-11-02',
            true,
          ],
        ],
        [['=HYPERLINK("x")', 0, 0, null, null, false]],
      ),
    );

    const hoja = libro.getWorksheet(NOMBRE_DE_HOJA);
    expect(libro.worksheets).toHaveLength(1);
    expect(hoja?.rowCount).toBe(3);
    expect(hoja?.getRow(1).values).toEqual([
      undefined,
      'Cliente',
      'Total',
      'Unidades',
      'Alta',
      'Vence',
      'Activo',
    ]);
    expect(hoja?.getRow(1).font?.bold).toBe(true);
    expect(hoja?.getCell('A2').value).toBe('Ana');
    expect(hoja?.getCell('B2').value).toBe(1500.5);
    expect(hoja?.getCell('F2').value).toBe('Sí');
    expect(hoja?.getCell('A3').value).toBe('=HYPERLINK("x")');
    expect(hoja?.getCell('F3').value).toBe('No');
  });

  it('da formato a las columnas: moneda, fechas y números', async () => {
    const libro = await generar(
      deLotes([
        [
          'Ana',
          10,
          1,
          new Date('2026-10-28T01:30:00.000Z'),
          '2026-11-02',
          true,
        ],
      ]),
    );

    const hoja = libro.getWorksheet(NOMBRE_DE_HOJA);
    expect(hoja?.getCell('B2').numFmt).toBe(formatoDeCelda('moneda'));
    expect(hoja?.getCell('C2').numFmt).toBe('0');
    expect(hoja?.getCell('D2').numFmt).toBe('dd/mm/yyyy hh:mm');
    expect(hoja?.getCell('E2').numFmt).toBe('dd/mm/yyyy');
  });

  it('guarda la fecha y hora tal como se ven en Argentina', async () => {
    const libro = await generar(
      deLotes([
        ['Ana', 1, 1, new Date('2026-10-28T01:30:00.000Z'), '2026-11-02', true],
      ]),
    );

    const hoja = libro.getWorksheet(NOMBRE_DE_HOJA);
    expect(hoja?.getCell('D2').value).toEqual(
      new Date('2026-10-27T22:30:00.000Z'),
    );
    expect(hoja?.getCell('E2').value).toEqual(
      new Date('2026-11-02T00:00:00.000Z'),
    );
  });

  it('sin filas escribe sólo los encabezados', async () => {
    const libro = await generar(deLotes());

    expect(libro.getWorksheet(NOMBRE_DE_HOJA)?.rowCount).toBe(1);
  });

  it('si falla un lote destruye el archivo y propaga el error', async () => {
    async function* falla(): AsyncGenerator<Celda[][]> {
      await Promise.resolve();
      yield [['Ana', 1, 1, null, null, true]];
      throw new Error('se cayó la base');
    }
    const salida = new PassThrough();
    salida.resume();
    const cerrado = new Promise<Error>((resolve) =>
      salida.on('error', resolve),
    );

    await expect(escribirXlsx(salida, encabezados, falla())).rejects.toThrow(
      'se cayó la base',
    );
    expect((await cerrado).message).toBe('se cayó la base');
  });
});

describe('Excel de exporte cuando el cliente corta', () => {
  it('deja de pedir lotes y no queda colgado si el destino se destruye', async () => {
    let pedidos = 0;
    async function* infinito(): AsyncGenerator<Celda[][]> {
      for (;;) {
        // Cede el turno para que corran los timers (un bucle de microtareas los deja sin correr).
        await new Promise((resolve) => setImmediate(resolve));
        pedidos += 1;
        yield [['Ana', 1, 1, null, null, true]];
      }
    }
    const salida = new PassThrough();
    salida.resume();
    const abortar = new AbortController();
    setTimeout(() => abortar.abort(), 20);

    await escribirXlsx(salida, encabezados, infinito(), abortar.signal);

    expect(salida.destroyed).toBe(true);
    expect(pedidos).toBeGreaterThan(0);
  });

  it('también corta si el destino se destruye solo', async () => {
    const salida = new PassThrough();
    salida.resume();
    async function* lotes(): AsyncGenerator<Celda[][]> {
      await Promise.resolve();
      yield [['Ana', 1, 1, null, null, true]];
      salida.destroy();
      yield [['Beto', 1, 1, null, null, true]];
    }

    await expect(
      escribirXlsx(salida, encabezados, lotes()),
    ).resolves.toBeUndefined();
  });
});

describe('valorDeCelda', () => {
  it.each([
    [null, 'texto', null],
    ['', 'moneda', null],
    ['12.5', 'decimal', 12.5],
    ['abc', 'entero', null],
    [true, 'booleano', 'Sí'],
  ] as const)('%p como %s da %p', (valor, tipo, esperado) => {
    expect(valorDeCelda(valor, tipo)).toBe(esperado);
  });

  it('corta el texto que no entra en una celda de Excel', () => {
    const valor = valorDeCelda('x'.repeat(40_000), 'texto');

    expect(typeof valor === 'string' && valor.length).toBe(32_000);
  });
});
