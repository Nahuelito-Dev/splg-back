import {
  CSV_LIBERACIONES,
  ENCABEZADO_LIBERACIONES,
} from '../testing/liberaciones-ejemplo';
import {
  armarCsvFiltrado,
  leerFecha,
  leerImporte,
  parsearReporteDeLiberaciones,
  ReleaseReportFormatError,
} from './release-report.parser';

describe('parsearReporteDeLiberaciones', () => {
  it('lee los movimientos y descarta el saldo inicial y la fila de totales', () => {
    const r = parsearReporteDeLiberaciones(CSV_LIBERACIONES);

    expect(r.rows).toHaveLength(10);
    expect(r.ignoredLines).toBe(2);
    expect(r.unreadable).toEqual([]);
    const cobro = r.rows[0];
    expect(cobro.sourceId).toBe('1001');
    expect(cobro.description).toBe('payment');
    expect(cobro.gross.toNumber()).toBe(1000);
    expect(cobro.mpFee.toNumber()).toBe(-50);
    expect(cobro.netCredit.toNumber()).toBe(950);
    expect(cobro.date?.toISOString()).toBe('2026-10-02T13:00:00.000Z');
  });

  it('distingue retenciones, retiros y devoluciones por sus columnas', () => {
    const r = parsearReporteDeLiberaciones(CSV_LIBERACIONES);
    const porId = (id: string) => r.rows.find((f) => f.sourceId === id);

    expect(porId('1003')?.taxes.toNumber()).toBe(-30);
    expect(porId('9001')?.description).toBe('payout');
    expect(porId('9001')?.netDebit.toNumber()).toBe(10000);
    expect(porId('1005')?.mpFee.toNumber()).toBe(250);
  });

  it('acepta punto y coma, decimales con coma, BOM y comillas', () => {
    const csv =
      '﻿DATE;SOURCE_ID;RECORD_TYPE;DESCRIPTION;NET_CREDIT_AMOUNT;NET_DEBIT_AMOUNT;GROSS_AMOUNT\r\n' +
      '2026-10-02T10:00:00.000-03:00;55;release;"payment";"1.234,56";0,00;"1.300,00"\r\n';

    const r = parsearReporteDeLiberaciones(csv);

    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].netCredit.toNumber()).toBe(1234.56);
    expect(r.rows[0].gross.toNumber()).toBe(1300);
  });

  it('las columnas opcionales que la cuenta no trae (RECORD_TYPE, FINANCING_FEE_AMOUNT…) valen cero o vacío', () => {
    const r = parsearReporteDeLiberaciones(CSV_LIBERACIONES);

    expect(r.rows[0].recordType).toBe('');
    expect(r.rows[0].financingFee.toNumber()).toBe(0);
    expect(r.rows[0].externalReference).toBe('');
    expect(r.rows[0].coupon.toNumber()).toBe(0);
  });

  it('sin RECORD_TYPE los saldos y los totales se reconocen por su descripción, incluidos los saldos previos a un retiro', () => {
    const csv = [
      ENCABEZADO_LIBERACIONES,
      '2026-10-02T10:00:00.000-03:00;;;pre_payout_1948976543;0;0;0;0;0;;;;100;;',
      '2026-10-02T10:00:00.000-03:00;;;pos_payout_1948976543;0;0;0;0;0;;;;0;;',
      '2026-10-02T10:00:00.000-03:00;;5;payment;5.00;0.00;5.00;0;0;visa;;;0;;',
    ].join('\n');

    const r = parsearReporteDeLiberaciones(csv);

    expect(r.rows.map((f) => f.sourceId)).toEqual(['5']);
    expect(r.ignoredLines).toBe(2);
  });

  it('respeta comillas con separador y salto de línea dentro del campo', () => {
    const csv =
      'SOURCE_ID,RECORD_TYPE,DESCRIPTION,EXTERNAL_REFERENCE,NET_CREDIT_AMOUNT\n' +
      '9,release,payment,"ref, con ""coma""\ny salto",10.50\n';

    const r = parsearReporteDeLiberaciones(csv);

    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].externalReference).toBe('ref, con "coma"\ny salto');
    expect(r.rows[0].netCredit.toNumber()).toBe(10.5);
  });

  it('separa las filas ilegibles sin cortar el resto', () => {
    const csv = [
      ENCABEZADO_LIBERACIONES,
      '2026-10-02T10:00:00.000-03:00;;1;payment;abc;0.00;10.00;0;0;visa;;;0;;',
      '2026-10-02T10:00:00.000-03:00;;2;payment;5.00;0.00;5.00;0;0;visa;;;0;;',
      '2026-10-02;corta',
    ].join('\n');

    const r = parsearReporteDeLiberaciones(csv);

    expect(r.rows.map((f) => f.sourceId)).toEqual(['2']);
    expect(r.unreadable).toHaveLength(2);
    expect(r.unreadable[0].reason).toContain('importe ilegible');
  });

  it('falla si falta una columna imprescindible o el archivo está vacío', () => {
    expect(() => parsearReporteDeLiberaciones('Fecha,Monto\n1,2')).toThrow(
      ReleaseReportFormatError,
    );
    expect(() => parsearReporteDeLiberaciones('Fecha,Monto\n1,2')).toThrow(
      /SOURCE_ID, DESCRIPTION/,
    );
    expect(() => parsearReporteDeLiberaciones('')).toThrow(
      'El reporte está vacío',
    );
  });

  it('armarCsvFiltrado conserva el encabezado y las filas elegidas tal como vinieron', () => {
    const r = parsearReporteDeLiberaciones(CSV_LIBERACIONES);

    const filtrado = armarCsvFiltrado(r.headerLine, [r.rows[0]]);

    expect(filtrado.split('\n')).toEqual([
      ENCABEZADO_LIBERACIONES,
      r.rows[0].raw,
      '',
    ]);
  });
});

describe('leerImporte', () => {
  it.each([
    ['1234.56', 1234.56],
    ['-43.04', -43.04],
    ['1.234,56', 1234.56],
    ['1,234.56', 1234.56],
    ['1234,5', 1234.5],
    ['1,234,567', 1234567],
    ['1.234.567', 1234567],
    ['', 0],
    ['-', 0],
    ['$ 10', 10],
  ])('%s -> %s', (entrada, esperado) => {
    expect(leerImporte(entrada).toNumber()).toBe(esperado);
  });

  it('rechaza lo que no es un número', () => {
    expect(() => leerImporte('12x')).toThrow('importe ilegible');
  });
});

describe('leerFecha', () => {
  it('toma la zona del texto y, sin zona, la hora argentina', () => {
    expect(leerFecha('2026-10-02T10:00:00.000-04:00')?.toISOString()).toBe(
      '2026-10-02T14:00:00.000Z',
    );
    expect(leerFecha('2026-10-02 10:00:00')?.toISOString()).toBe(
      '2026-10-02T13:00:00.000Z',
    );
    expect(leerFecha('')).toBeNull();
    expect(leerFecha('ayer')).toBeNull();
  });
});
