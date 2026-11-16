import { createHash } from 'crypto';
import Decimal from 'decimal.js';
import { CashDirection } from '../../cash/domain/cash.enums';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { MpDifferenceKind } from './mp-reconciliation.enums';
import type { ReleaseRow } from './release-report.parser';

/** Un cobro de Mercado Pago de la distribuidora tal como lo tiene el libro. */
export interface PagoDelLibro {
  paymentId: string;
  orderId: string;
  gatewayPaymentId: string;
  /** El ingreso asentado en la caja; `null` si el cobro quedó sin asentar. */
  ingreso: {
    cashBoxId: string;
    amount: Decimal;
    occurredAt: Date;
  } | null;
  /** La comisión ya asentada (con los ajustes de conciliación); `null` si no hay. */
  comision: Decimal | null;
  /**
   * Lo devuelto o a punto de devolverse de este cobro: solicitudes de devolución
   * cerradas o en curso más los egresos de devoluciones externas (como la etapa 3).
   */
  devolucionComprometida: Decimal;
}

export interface EntradaDeConciliacion {
  filas: ReadonlyArray<ReleaseRow>;
  /** Cobros de la distribuidora que pide, por id de Mercado Pago. */
  propios: ReadonlyMap<string, PagoDelLibro>;
  /** Ids de Mercado Pago de cobros de OTRAS distribuidoras: se ignoran sin dejar rastro. */
  ajenos: ReadonlySet<string>;
  /** Ids de pagos del sistema que no tienen distribuidora: los ve sólo el super admin. */
  sinDistribuidora: ReadonlySet<string>;
  /** Filas ya asentadas por otra corrida (clave de fila). */
  aplicadas: ReadonlySet<string>;
  /** Cobros de la distribuidora con ingreso en el rango, para detectar ingresos sin cobro en el reporte. */
  ingresosDelRango: ReadonlyArray<PagoDelLibro>;
}

export interface DiferenciaBorrador {
  kind: MpDifferenceKind;
  /** Identifica la fila del reporte y el tipo de ajuste, igual en corridas que se pisan. */
  rowKey: string;
  /** Sólo la ve (y la asienta) el super admin: no pertenece a ninguna distribuidora. */
  accountLevel: boolean;
  sourceId: string | null;
  paymentId: string | null;
  orderId: string | null;
  occurredAt: Date | null;
  mpDescription: string;
  mpAmount: Decimal | null;
  ledgerAmount: Decimal | null;
  difference: Decimal | null;
  /** Aparte del importe: la comisión que acompaña al cobro o al retiro. */
  extraAmount: Decimal | null;
  direction: CashDirection | null;
  appliable: boolean;
  /** El retiro necesita que el administrador elija la caja de destino. */
  needsCashBox: boolean;
  note: string;
}

export interface ResultadoDeConciliacion {
  diferencias: DiferenciaBorrador[];
  /** Filas de la distribuidora que ya se habían asentado en otra corrida. */
  yaAsentadas: number;
  /** Filas de la cuenta que ya se habían asentado (sólo las cuenta el super admin). */
  yaAsentadasDeCuenta: number;
  /** Filas de cobros de otras distribuidoras (no se muestran). */
  deOtrasDistribuidoras: number;
}

const TOLERANCIA = new Decimal('0.01');

/**
 * Clave estable de una fila del reporte y un tipo de ajuste: un mismo movimiento nunca se
 * asienta dos veces. Usa el día argentino y los importes, no la hora ni la zona con que
 * el reporte muestra las fechas.
 */
export function claveDeFila(kind: MpDifferenceKind, fila: ReleaseRow): string {
  const huella = [
    kind,
    fila.sourceId,
    fila.description,
    fila.date ? diaArgentino(fila.date) : '',
    fila.netCredit.toFixed(2),
    fila.netDebit.toFixed(2),
    fila.gross.toFixed(2),
    fila.mpFee.toFixed(2),
    fila.taxes.toFixed(2),
  ].join('|');
  const hex = createHash('sha1').update(huella).digest('hex');
  const variante = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80)
    .toString(16)
    .padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variante}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

const esImpuesto = (descripcion: string): boolean =>
  descripcion.startsWith('tax_');

const esRetiro = (descripcion: string): boolean =>
  descripcion === 'payout' || descripcion === 'withdrawal';

/** Lo que Mercado Pago le cobró al comercio por un cobro: comisión más costo de financiación. */
function comisionDeFila(fila: ReleaseRow): Decimal {
  return fila.mpFee.abs().plus(fila.financingFee.abs());
}

/** Lo que se devuelve al cliente en una devolución o contracargo: el bruto (como en la etapa 3). */
function brutoDevuelto(fila: ReleaseRow): Decimal {
  return fila.gross.lt(0) ? fila.gross.abs() : fila.netDebit;
}

function base(
  kind: MpDifferenceKind,
  fila: ReleaseRow,
  extra: Partial<DiferenciaBorrador> & Pick<DiferenciaBorrador, 'note'>,
): DiferenciaBorrador {
  return {
    kind,
    rowKey: claveDeFila(kind, fila),
    accountLevel: false,
    sourceId: fila.sourceId || null,
    paymentId: null,
    orderId: null,
    occurredAt: fila.date,
    mpDescription: fila.description,
    mpAmount: null,
    ledgerAmount: null,
    difference: null,
    extraAmount: null,
    direction: null,
    appliable: false,
    needsCashBox: false,
    ...extra,
  };
}

/** Varias filas de liberación de un mismo cobro (cuotas, ajustes) se comparan como una sola. */
function agruparCobros(filas: ReadonlyArray<ReleaseRow>): ReleaseRow[] {
  const resultado: ReleaseRow[] = [];
  const porId = new Map<string, number>();
  for (const fila of filas) {
    const esCobro = fila.description === 'payment' && fila.sourceId !== '';
    const indice = esCobro ? porId.get(fila.sourceId) : undefined;
    if (!esCobro || indice === undefined) {
      if (esCobro) porId.set(fila.sourceId, resultado.length);
      resultado.push(fila);
      continue;
    }
    const previa = resultado[indice];
    resultado[indice] = {
      ...previa,
      date:
        previa.date && fila.date && fila.date < previa.date
          ? fila.date
          : (previa.date ?? fila.date),
      netCredit: previa.netCredit.plus(fila.netCredit),
      netDebit: previa.netDebit.plus(fila.netDebit),
      gross: previa.gross.plus(fila.gross),
      mpFee: previa.mpFee.plus(fila.mpFee),
      financingFee: previa.financingFee.plus(fila.financingFee),
      shippingFee: previa.shippingFee.plus(fila.shippingFee),
      taxes: previa.taxes.plus(fila.taxes),
      coupon: previa.coupon.plus(fila.coupon),
    };
  }
  return resultado;
}

/**
 * Compara cada fila del reporte de liberaciones con el libro de cajas. Sólo
 * mira los cobros de la distribuidora que pide; lo que no es de ninguna
 * distribuidora (retiros, impuestos sueltos, cobros desconocidos) sale marcado
 * `accountLevel`. Es una función pura: no toca la base.
 */
export function conciliar(
  entrada: EntradaDeConciliacion,
): ResultadoDeConciliacion {
  const diferencias: DiferenciaBorrador[] = [];
  const vistas = new Set<string>();
  let yaAsentadas = 0;
  let yaAsentadasDeCuenta = 0;
  let deOtras = 0;
  const cobrosEnElReporte = new Set<string>();
  const filas = agruparCobros(entrada.filas);
  /** Lo que ya está cubierto por devoluciones del cobro, y se va consumiendo fila a fila. */
  const reservas = new Map<string, Decimal>();
  /** Retenciones que ya vienen en `TAXES_AMOUNT` de un cobro: una fila `tax_*` igual no se asienta de nuevo. */
  const retenidas = new Map<string, Decimal>();
  for (const fila of filas) {
    if (fila.description === 'payment' && fila.taxes.lt(0)) {
      retenidas.set(
        fila.sourceId,
        (retenidas.get(fila.sourceId) ?? new Decimal(0)).plus(fila.taxes.abs()),
      );
    }
  }

  const agregar = (d: DiferenciaBorrador): void => {
    if (vistas.has(d.rowKey)) return;
    vistas.add(d.rowKey);
    if (entrada.aplicadas.has(d.rowKey)) {
      if (d.accountLevel) yaAsentadasDeCuenta++;
      else yaAsentadas++;
      return;
    }
    diferencias.push(d);
  };

  for (const fila of filas) {
    const descripcion = fila.description;
    const pago = fila.sourceId ? entrada.propios.get(fila.sourceId) : undefined;
    const ajeno = !!fila.sourceId && entrada.ajenos.has(fila.sourceId);

    if (descripcion === 'payment') {
      if (ajeno) {
        deOtras++;
        continue;
      }
      if (!pago) {
        const sinDueno = entrada.sinDistribuidora.has(fila.sourceId);
        agregar(
          base(MpDifferenceKind.UNKNOWN_PAYMENT, fila, {
            accountLevel: true,
            mpAmount: fila.gross,
            note: sinDueno
              ? 'El pago existe en el sistema pero no tiene distribuidora. No se asienta.'
              : 'El cobro no corresponde a ningún pago del sistema: puede ser una venta fuera de SPLG. No se asienta.',
          }),
        );
        continue;
      }
      cobrosEnElReporte.add(pago.gatewayPaymentId);
      conciliarCobro(fila, pago, agregar);
      continue;
    }

    if (descripcion === 'refund' || descripcion === 'chargeback') {
      if (ajeno) {
        deOtras++;
        continue;
      }
      if (!pago) {
        agregar(otroMovimiento(fila));
        continue;
      }
      cobrosEnElReporte.add(pago.gatewayPaymentId);
      if (!reservas.has(pago.paymentId)) {
        reservas.set(pago.paymentId, pago.devolucionComprometida);
      }
      conciliarDevolucion(fila, pago, reservas, entrada.aplicadas, agregar);
      continue;
    }

    if (esRetiro(descripcion)) {
      const importe = fila.gross.abs().gt(0) ? fila.gross.abs() : fila.netDebit;
      if (importe.lte(0)) continue;
      const comision = comisionDeFila(fila);
      agregar(
        base(MpDifferenceKind.PAYOUT, fila, {
          accountLevel: true,
          mpAmount: importe,
          extraAmount: comision.gt(0) ? comision : null,
          direction: CashDirection.OUT,
          appliable: true,
          needsCashBox: true,
          note: 'Retiro de la billetera: se asienta como transferencia a la caja de destino que elijas.',
        }),
      );
      continue;
    }

    if (esImpuesto(descripcion)) {
      const entra = descripcion.endsWith('_cancel') || fila.netCredit.gt(0);
      const importe = entra
        ? fila.netCredit.gt(0)
          ? fila.netCredit
          : fila.taxes.abs()
        : fila.netDebit.gt(0)
          ? fila.netDebit
          : fila.taxes.abs();
      if (importe.lte(0)) continue;
      const yaEnElCobro = retenidas.get(fila.sourceId);
      if (
        !entra &&
        yaEnElCobro &&
        yaEnElCobro.minus(importe).abs().lte(TOLERANCIA)
      ) {
        // La misma retención ya viene en `TAXES_AMOUNT` del cobro: no se asienta dos veces.
        retenidas.delete(fila.sourceId);
        continue;
      }
      agregar(
        base(MpDifferenceKind.TAX_ROW, fila, {
          accountLevel: true,
          mpAmount: importe,
          direction: entra ? CashDirection.IN : CashDirection.OUT,
          appliable: true,
          note: entra
            ? 'Mercado Pago devolvió una retención o impuesto: ingresa como reintegro.'
            : 'Impuesto o retención que Mercado Pago descontó de la cuenta: sale como «Impuestos y retenciones».',
        }),
      );
      continue;
    }

    if (fila.netCredit.gt(0) || fila.netDebit.gt(0)) {
      agregar(otroMovimiento(fila));
    }
  }

  for (const pago of entrada.ingresosDelRango) {
    if (cobrosEnElReporte.has(pago.gatewayPaymentId) || !pago.ingreso) continue;
    const ficticia = filaDeLibro(pago);
    agregar(
      base(MpDifferenceKind.LEDGER_WITHOUT_MP, ficticia, {
        paymentId: pago.paymentId,
        orderId: pago.orderId,
        sourceId: pago.gatewayPaymentId,
        occurredAt: pago.ingreso.occurredAt,
        mpDescription: 'payment',
        ledgerAmount: pago.ingreso.amount,
        note: 'La caja tiene este ingreso pero el reporte del rango no trae el cobro: Mercado Pago lo libera en otra fecha o falta. No se asienta nada.',
      }),
    );
  }

  return {
    diferencias,
    yaAsentadas,
    yaAsentadasDeCuenta,
    deOtrasDistribuidoras: deOtras,
  };
}

function otroMovimiento(fila: ReleaseRow): DiferenciaBorrador {
  const importe = fila.netCredit.gt(0) ? fila.netCredit : fila.netDebit;
  return base(MpDifferenceKind.OTHER_MOVEMENT, fila, {
    accountLevel: true,
    mpAmount: importe,
    direction: fila.netCredit.gt(0) ? CashDirection.IN : CashDirection.OUT,
    note: 'Movimiento que el sistema no sabe asentar solo: revisalo en Mercado Pago y cargalo a mano si corresponde.',
  });
}

/** Una fila para identificar un ingreso del libro (no viene del reporte). */
function filaDeLibro(pago: PagoDelLibro): ReleaseRow {
  return {
    line: 0,
    raw: '',
    date: pago.ingreso?.occurredAt ?? null,
    sourceId: pago.gatewayPaymentId,
    externalReference: '',
    recordType: 'release',
    description: 'payment',
    netCredit: pago.ingreso?.amount ?? new Decimal(0),
    netDebit: new Decimal(0),
    gross: pago.ingreso?.amount ?? new Decimal(0),
    mpFee: new Decimal(0),
    financingFee: new Decimal(0),
    shippingFee: new Decimal(0),
    taxes: new Decimal(0),
    coupon: new Decimal(0),
    paymentMethod: '',
  };
}

function conciliarCobro(
  fila: ReleaseRow,
  pago: PagoDelLibro,
  agregar: (d: DiferenciaBorrador) => void,
): void {
  const comision = comisionDeFila(fila);
  const impuestos = fila.taxes.lt(0) ? fila.taxes.abs() : new Decimal(0);
  const comunes = {
    paymentId: pago.paymentId,
    orderId: pago.orderId,
  };
  const retencion = (appliable: boolean, note: string): void =>
    agregar(
      base(MpDifferenceKind.TAX_WITHHOLDING, fila, {
        ...comunes,
        mpAmount: impuestos,
        direction: CashDirection.OUT,
        appliable,
        note,
      }),
    );
  if (!pago.ingreso) {
    agregar(
      base(MpDifferenceKind.PAYMENT_NOT_IN_CASH, fila, {
        ...comunes,
        mpAmount: fila.gross,
        extraAmount: comision.gt(0) ? comision : null,
        direction: CashDirection.IN,
        appliable: fila.gross.gt(0),
        note: 'Mercado Pago cobró y la caja no tiene el ingreso: se asienta el cobro con su comisión.',
      }),
    );
    if (impuestos.gt(0)) {
      retencion(
        false,
        'Mercado Pago retuvo impuestos de este cobro; asentá primero el cobro.',
      );
    }
    return;
  }
  if (fila.gross.minus(pago.ingreso.amount).abs().gt(TOLERANCIA)) {
    agregar(
      base(MpDifferenceKind.AMOUNT_MISMATCH, fila, {
        ...comunes,
        mpAmount: fila.gross,
        ledgerAmount: pago.ingreso.amount,
        difference: fila.gross.minus(pago.ingreso.amount),
        note: 'El importe del ingreso difiere del bruto que informa Mercado Pago. Los movimientos no se editan: corregilo con un ajuste manual si corresponde.',
      }),
    );
  }
  const textoRetencion =
    'Mercado Pago retuvo impuestos de este cobro y no tienen egreso: se asientan como «Impuestos y retenciones».';
  if (pago.comision === null) {
    if (comision.gt(0)) {
      agregar(
        base(MpDifferenceKind.FEE_PENDING, fila, {
          ...comunes,
          mpAmount: comision,
          difference: comision,
          direction: CashDirection.OUT,
          appliable: true,
          note: 'El cobro entró sin comisión: se asienta la que informa el reporte.',
        }),
      );
    }
    if (impuestos.gt(0)) retencion(true, textoRetencion);
    return;
  }
  const deComision = comision.minus(pago.comision);
  const deTodo = comision.plus(impuestos).minus(pago.comision);
  if (impuestos.gt(0) && deTodo.abs().lte(TOLERANCIA)) {
    // La comisión asentada ya incluye las retenciones (bruto menos neto recibido): no hay nada que asentar.
    return;
  }
  if (deComision.abs().lte(TOLERANCIA)) {
    if (impuestos.gt(0)) retencion(true, textoRetencion);
    return;
  }
  // Comisión (y, si hay, retenciones) distintas de lo asentado: una sola diferencia, para no asentar el impuesto dos veces.
  const diferencia = impuestos.gt(0) ? deTodo : deComision;
  agregar(
    base(MpDifferenceKind.FEE_MISMATCH, fila, {
      ...comunes,
      mpAmount: impuestos.gt(0) ? comision.plus(impuestos) : comision,
      ledgerAmount: pago.comision,
      difference: diferencia,
      direction: diferencia.gt(0) ? CashDirection.OUT : CashDirection.IN,
      appliable: true,
      note: `${impuestos.gt(0) ? 'Comisión más impuestos y retenciones' : 'Comisión'} distintos de lo asentado: ${
        diferencia.gt(0)
          ? 'se asienta la diferencia como egreso.'
          : 'la diferencia ingresa como reintegro.'
      }`,
    }),
  );
}

function conciliarDevolucion(
  fila: ReleaseRow,
  pago: PagoDelLibro,
  reservas: Map<string, Decimal>,
  aplicadas: ReadonlySet<string>,
  agregar: (d: DiferenciaBorrador) => void,
): void {
  const comunes = { paymentId: pago.paymentId, orderId: pago.orderId };
  const sale = fila.netDebit.gt(0) || fila.gross.lt(0);
  if (!sale) {
    agregar(otroMovimiento(fila));
    return;
  }
  // Se devuelve el bruto; la comisión y los impuestos que Mercado Pago devuelve entran aparte.
  const importe = brutoDevuelto(fila);
  const contracargo = fila.description === 'chargeback';
  const reserva = reservas.get(pago.paymentId) ?? new Decimal(0);
  const cubierto = Decimal.min(reserva, importe);
  reservas.set(pago.paymentId, reserva.minus(cubierto));
  const falta = importe.minus(cubierto);
  const clave = claveDeFila(MpDifferenceKind.REFUND_MISSING, fila);
  if (falta.gt(TOLERANCIA) || aplicadas.has(clave)) {
    agregar(
      base(MpDifferenceKind.REFUND_MISSING, fila, {
        ...comunes,
        mpAmount: falta.gt(TOLERANCIA) ? falta : importe,
        direction: CashDirection.OUT,
        appliable: !!pago.ingreso,
        note: pago.ingreso
          ? `${contracargo ? 'Contracargo' : 'Devolución'} en Mercado Pago sin egreso en la caja: se asienta como devolución al cliente por el bruto.`
          : 'La devolución es de un cobro que no entró a la caja: asentá primero el cobro.',
      }),
    );
  }
  if (!pago.ingreso) return;
  const comision = fila.mpFee.gt(0) ? fila.mpFee : new Decimal(0);
  const financiacion = fila.financingFee.gt(0)
    ? fila.financingFee
    : new Decimal(0);
  const reintegro = comision.plus(financiacion);
  if (reintegro.gt(0)) {
    agregar(
      base(MpDifferenceKind.FEE_REIMBURSEMENT, fila, {
        ...comunes,
        mpAmount: reintegro,
        direction: CashDirection.IN,
        appliable: true,
        note: 'Mercado Pago devolvió la comisión del cobro devuelto: ingresa como «Reintegros de Mercado Pago».',
      }),
    );
  }
  if (fila.taxes.gt(0)) {
    agregar(
      base(MpDifferenceKind.TAX_REFUND, fila, {
        ...comunes,
        mpAmount: fila.taxes,
        direction: CashDirection.IN,
        appliable: true,
        note: 'Mercado Pago devolvió impuestos o retenciones del cobro devuelto: ingresan como «Reintegros de Mercado Pago».',
      }),
    );
  }
}

/** Cuántas diferencias hay en total: la suma de las cantidades por tipo. */
export function totalDeDiferencias(
  porTipo: Readonly<Record<string, number>>,
): number {
  return Object.values(porTipo).reduce((suma, n) => suma + n, 0);
}

/**
 * Brecha neta: cuánto más neto informa Mercado Pago que lo que tiene la caja
 * en el rango (negativa: la caja tiene más).
 */
export function brechaNeta(
  netoMercadoPago: Decimal.Value,
  netoCaja: Decimal.Value,
): number {
  return new Decimal(netoMercadoPago)
    .minus(netoCaja)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toNumber();
}
