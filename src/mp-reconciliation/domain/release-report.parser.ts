import Decimal from 'decimal.js';

/** Una fila de movimiento del reporte de liberaciones, ya tipada. */
export interface ReleaseRow {
  /** Número de línea en el archivo (la primera es el encabezado). */
  line: number;
  /** La línea tal como vino, para rearmar el archivo filtrado. */
  raw: string;
  date: Date | null;
  sourceId: string;
  externalReference: string;
  recordType: string;
  description: string;
  netCredit: Decimal;
  netDebit: Decimal;
  gross: Decimal;
  mpFee: Decimal;
  financingFee: Decimal;
  shippingFee: Decimal;
  taxes: Decimal;
  coupon: Decimal;
  paymentMethod: string;
}

export interface ParsedReleaseReport {
  /** Encabezado tal como vino. */
  headerLine: string;
  /** Filas de movimiento (`release`, `payout`…); no incluye saldos ni totales. */
  rows: ReleaseRow[];
  /** Filas que son saldos o totales (no son movimientos). */
  ignoredLines: number;
  /** Líneas que no se pudieron leer (columnas de menos, importes ilegibles). */
  unreadable: Array<{ line: number; reason: string }>;
}

export class ReleaseReportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseReportFormatError';
  }
}

/** Filas que no son movimientos: saldos y totales. */
const RECORD_TYPES_SIN_MOVIMIENTO = new Set([
  'initial_available_balance',
  'available_balance',
  'total',
  'final_available_balance',
]);

/** Columnas sin las que no se puede conciliar. */
/** Las demás (RECORD_TYPE, EXTERNAL_REFERENCE, FINANCING_FEE_AMOUNT…) son opcionales: la cuenta elige qué columnas trae el reporte. */
const COLUMNAS_OBLIGATORIAS = ['SOURCE_ID', 'DESCRIPTION'];

const SEPARADORES = [',', ';', '\t'] as const;

/** Parte el texto en registros y campos, respetando comillas (con saltos de línea y comillas dobles escapadas). */
function partirRegistros(
  texto: string,
  separador: string,
): Array<{ campos: string[]; raw: string; linea: number }> {
  const registros: Array<{ campos: string[]; raw: string; linea: number }> = [];
  let campos: string[] = [];
  let campo = '';
  let enComillas = false;
  let inicio = 0;
  let linea = 1;
  let lineaInicio = 1;
  const cerrarRegistro = (fin: number): void => {
    campos.push(campo);
    const raw = texto.slice(inicio, fin).replace(/\r$/, '');
    if (!(campos.length === 1 && campos[0].trim() === '')) {
      registros.push({ campos, raw, linea: lineaInicio });
    }
    campos = [];
    campo = '';
  };
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (enComillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else {
          enComillas = false;
        }
      } else {
        if (c === '\n') linea++;
        campo += c;
      }
      continue;
    }
    if (c === '"' && campo === '') {
      enComillas = true;
    } else if (c === separador) {
      campos.push(campo);
      campo = '';
    } else if (c === '\n') {
      cerrarRegistro(i);
      inicio = i + 1;
      linea++;
      lineaInicio = linea;
    } else if (c !== '\r') {
      campo += c;
    }
  }
  if (inicio < texto.length || campo !== '' || campos.length > 0) {
    cerrarRegistro(texto.length);
  }
  return registros;
}

/** El separador que usa el encabezado: el que lo parte en más columnas conocidas. */
function detectarSeparador(encabezado: string): string {
  let mejor: string = SEPARADORES[0];
  let mejorCantidad = 0;
  for (const s of SEPARADORES) {
    const columnas = encabezado
      .split(s)
      .map((c) => c.replace(/"/g, '').trim().toUpperCase());
    const conocidas = columnas.filter((c) =>
      [
        ...COLUMNAS_OBLIGATORIAS,
        'DATE',
        'GROSS_AMOUNT',
        'MP_FEE_AMOUNT',
      ].includes(c),
    ).length;
    if (conocidas > mejorCantidad) {
      mejorCantidad = conocidas;
      mejor = s;
    }
  }
  return mejor;
}

/**
 * Importe del reporte: acepta `1234.56`, `1.234,56`, `1,234.56`, `1234,56`, con
 * signo y espacios; vacío vale cero. Lanza si no es un número.
 */
export function leerImporte(valor: string | undefined): Decimal {
  const limpio = (valor ?? '').replace(/[\s$]/g, '');
  if (limpio === '' || limpio === '-') return new Decimal(0);
  const ultimaComa = limpio.lastIndexOf(',');
  const ultimoPunto = limpio.lastIndexOf('.');
  let normal = limpio;
  if (ultimaComa >= 0 && ultimoPunto >= 0) {
    normal =
      ultimaComa > ultimoPunto
        ? limpio.replace(/\./g, '').replace(',', '.')
        : limpio.replace(/,/g, '');
  } else if (ultimaComa >= 0) {
    const unaSola = limpio.indexOf(',') === ultimaComa;
    const decimales = limpio.length - ultimaComa - 1;
    normal =
      unaSola && decimales <= 2
        ? limpio.replace(',', '.')
        : limpio.replace(/,/g, '');
  } else if (ultimoPunto >= 0 && limpio.indexOf('.') !== ultimoPunto) {
    normal = limpio.replace(/\./g, '');
  }
  if (!/^[+-]?\d+(\.\d+)?$/.test(normal)) {
    throw new Error(`importe ilegible: "${valor}"`);
  }
  return new Decimal(normal);
}

/** Fecha ISO con zona (`2026-10-01T10:00:00.000-04:00`); sin zona se toma hora argentina. */
export function leerFecha(valor: string): Date | null {
  const texto = valor.trim();
  if (!texto) return null;
  const conZona = /(Z|[+-]\d{2}:?\d{2})$/.test(texto);
  const iso = texto.includes('T') ? texto : texto.replace(' ', 'T');
  const fecha = new Date(conZona ? iso : `${iso}-03:00`);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

/**
 * Lee el CSV del reporte de liberaciones. Tolera BOM, separador `,` `;` o tab,
 * campos entrecomillados, decimales con coma o punto y filas de saldos/totales
 * (se descartan). Las filas ilegibles no cortan el proceso: quedan en `unreadable`.
 */
export function parsearReporteDeLiberaciones(csv: string): ParsedReleaseReport {
  const texto = csv.replace(/^\uFEFF/, '');
  const primerSalto = texto.search(/\r?\n/);
  const primeraLinea = primerSalto === -1 ? texto : texto.slice(0, primerSalto);
  if (primeraLinea.trim() === '') {
    throw new ReleaseReportFormatError('El reporte está vacío');
  }
  const separador = detectarSeparador(primeraLinea);
  const registros = partirRegistros(texto, separador);
  const [encabezado, ...filas] = registros;
  const nombres = encabezado.campos.map((c) => c.trim().toUpperCase());
  const faltan = COLUMNAS_OBLIGATORIAS.filter((c) => !nombres.includes(c));
  if (faltan.length > 0) {
    throw new ReleaseReportFormatError(
      `El reporte no trae las columnas ${faltan.join(', ')}: configuralo en Mercado Pago con los nombres de columna en inglés y volvé a pedirlo`,
    );
  }
  const indice = new Map(nombres.map((n, i) => [n, i]));
  const valor = (campos: string[], columna: string): string =>
    (campos[indice.get(columna) ?? -1] ?? '').trim();

  const resultado: ParsedReleaseReport = {
    headerLine: encabezado.raw,
    rows: [],
    ignoredLines: 0,
    unreadable: [],
  };
  for (const fila of filas) {
    const recordType = valor(fila.campos, 'RECORD_TYPE').toLowerCase();
    const descripcion = valor(fila.campos, 'DESCRIPTION').toLowerCase();
    if (
      RECORD_TYPES_SIN_MOVIMIENTO.has(recordType) ||
      RECORD_TYPES_SIN_MOVIMIENTO.has(descripcion) ||
      /^(pre|pos)_payout_/.test(descripcion)
    ) {
      resultado.ignoredLines++;
      continue;
    }
    if (fila.campos.length < nombres.length - 2) {
      resultado.unreadable.push({
        line: fila.linea,
        reason: `tiene ${fila.campos.length} columnas y el encabezado ${nombres.length}`,
      });
      continue;
    }
    try {
      resultado.rows.push({
        line: fila.linea,
        raw: fila.raw,
        date: leerFecha(valor(fila.campos, 'DATE')),
        sourceId: valor(fila.campos, 'SOURCE_ID'),
        externalReference: valor(fila.campos, 'EXTERNAL_REFERENCE'),
        recordType,
        description: descripcion,
        netCredit: leerImporte(valor(fila.campos, 'NET_CREDIT_AMOUNT')),
        netDebit: leerImporte(valor(fila.campos, 'NET_DEBIT_AMOUNT')),
        gross: leerImporte(valor(fila.campos, 'GROSS_AMOUNT')),
        mpFee: leerImporte(valor(fila.campos, 'MP_FEE_AMOUNT')),
        financingFee: leerImporte(valor(fila.campos, 'FINANCING_FEE_AMOUNT')),
        shippingFee: leerImporte(valor(fila.campos, 'SHIPPING_FEE_AMOUNT')),
        taxes: leerImporte(valor(fila.campos, 'TAXES_AMOUNT')),
        coupon: leerImporte(valor(fila.campos, 'COUPON_AMOUNT')),
        paymentMethod: valor(fila.campos, 'PAYMENT_METHOD'),
      });
    } catch (error) {
      resultado.unreadable.push({
        line: fila.linea,
        reason: error instanceof Error ? error.message : 'fila ilegible',
      });
    }
  }
  return resultado;
}

/** Rearma un CSV con el encabezado y sólo las filas indicadas (para el archivo de cada distribuidora). */
export function armarCsvFiltrado(
  headerLine: string,
  filas: ReadonlyArray<Pick<ReleaseRow, 'raw'>>,
): string {
  return [headerLine, ...filas.map((f) => f.raw)].join('\n') + '\n';
}
