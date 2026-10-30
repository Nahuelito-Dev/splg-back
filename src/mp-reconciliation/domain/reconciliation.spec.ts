import Decimal from 'decimal.js';
import { CashDirection } from '../../cash/domain/cash.enums';
import {
  CSV_LIBERACIONES,
  ENCABEZADO_LIBERACIONES,
} from '../testing/liberaciones-ejemplo';
import { MpDifferenceKind } from './mp-reconciliation.enums';
import {
  claveDeFila,
  conciliar,
  EntradaDeConciliacion,
  PagoDelLibro,
} from './reconciliation';
import { parsearReporteDeLiberaciones } from './release-report.parser';

const pago = (id: string, extra: Partial<PagoDelLibro> = {}): PagoDelLibro => ({
  paymentId: `pay-${id}`,
  orderId: `ord-${id}`,
  gatewayPaymentId: id,
  ingreso: null,
  comision: null,
  devolucionComprometida: new Decimal(0),
  ...extra,
});

const ingreso = (monto: number) => ({
  cashBoxId: 'wallet-1',
  amount: new Decimal(monto),
  occurredAt: new Date('2026-10-02T13:00:00Z'),
});

function entradaBase(
  cambios: Partial<EntradaDeConciliacion> = {},
): EntradaDeConciliacion {
  const propios = [
    pago('1001', { ingreso: ingreso(1000), comision: new Decimal(50) }),
    pago('1002'),
    pago('1003', { ingreso: ingreso(3000) }),
    pago('1004', { ingreso: ingreso(3900), comision: new Decimal(180) }),
    pago('1005', { ingreso: ingreso(5000), comision: new Decimal(250) }),
    pago('1006', {
      ingreso: ingreso(600),
      devolucionComprometida: new Decimal(600),
    }),
  ];
  return {
    filas: parsearReporteDeLiberaciones(CSV_LIBERACIONES).rows,
    propios: new Map(propios.map((p) => [p.gatewayPaymentId, p])),
    ajenos: new Set(['8888']),
    sinDistribuidora: new Set(),
    aplicadas: new Set(),
    ingresosDelRango: propios,
    ...cambios,
  };
}

const tipos = (r: ReturnType<typeof conciliar>, kind: MpDifferenceKind) =>
  r.diferencias.filter((d) => d.kind === kind);

describe('conciliar', () => {
  const resultado = conciliar(entradaBase());

  it('un cobro con ingreso, comisión e importes iguales no deja diferencias', () => {
    expect(resultado.diferencias.filter((d) => d.sourceId === '1001')).toEqual(
      [],
    );
  });

  it('cobro en Mercado Pago sin ingreso en la caja: se puede asentar con su comisión', () => {
    const [d] = tipos(resultado, MpDifferenceKind.PAYMENT_NOT_IN_CASH);

    expect(d.sourceId).toBe('1002');
    expect(d.paymentId).toBe('pay-1002');
    expect(d.mpAmount?.toNumber()).toBe(2000);
    expect(d.extraAmount?.toNumber()).toBe(100);
    expect(d.direction).toBe(CashDirection.IN);
    expect(d.appliable).toBe(true);
    expect(d.accountLevel).toBe(false);
  });

  it('cobro que entró sin comisión: comisión pendiente por la del reporte', () => {
    const [d] = tipos(resultado, MpDifferenceKind.FEE_PENDING);

    expect(d.sourceId).toBe('1003');
    expect(d.mpAmount?.toNumber()).toBe(150);
    expect(d.direction).toBe(CashDirection.OUT);
    expect(d.appliable).toBe(true);
  });

  it('impuestos y retenciones del cobro sin egreso: egreso a asentar', () => {
    const [d] = tipos(resultado, MpDifferenceKind.TAX_WITHHOLDING);

    expect(d.sourceId).toBe('1003');
    expect(d.mpAmount?.toNumber()).toBe(30);
    expect(d.direction).toBe(CashDirection.OUT);
    expect(d.appliable).toBe(true);
  });

  it('importe distinto: sólo se informa, los movimientos no se editan', () => {
    const [d] = tipos(resultado, MpDifferenceKind.AMOUNT_MISMATCH);

    expect(d.sourceId).toBe('1004');
    expect(d.mpAmount?.toNumber()).toBe(4000);
    expect(d.ledgerAmount?.toNumber()).toBe(3900);
    expect(d.difference?.toNumber()).toBe(100);
    expect(d.appliable).toBe(false);
  });

  it('comisión distinta: egreso por la diferencia; si fuera menor, un ingreso', () => {
    const [d] = tipos(resultado, MpDifferenceKind.FEE_MISMATCH);
    expect(d.sourceId).toBe('1004');
    expect(d.difference?.toNumber()).toBe(20);
    expect(d.direction).toBe(CashDirection.OUT);

    const menor = conciliar(
      entradaBase({
        propios: new Map([
          [
            '1004',
            pago('1004', {
              ingreso: ingreso(4000),
              comision: new Decimal(230),
            }),
          ],
        ]),
        ingresosDelRango: [],
      }),
    );
    const [m] = tipos(menor, MpDifferenceKind.FEE_MISMATCH);
    expect(m.difference?.toNumber()).toBe(-30);
    expect(m.direction).toBe(CashDirection.IN);
  });

  it('devolución sin egreso en la caja: se asienta por el bruto; la comisión que devolvió MP ingresa aparte', () => {
    const [dev] = tipos(resultado, MpDifferenceKind.REFUND_MISSING);
    expect(dev.sourceId).toBe('1005');
    expect(dev.mpAmount?.toNumber()).toBe(5000);
    expect(dev.direction).toBe(CashDirection.OUT);
    expect(dev.appliable).toBe(true);

    const [reintegro] = tipos(resultado, MpDifferenceKind.FEE_REIMBURSEMENT);
    expect(reintegro.sourceId).toBe('1005');
    expect(reintegro.mpAmount?.toNumber()).toBe(250);
    expect(reintegro.direction).toBe(CashDirection.IN);
  });

  it('un contracargo que ya tiene egreso no se repite', () => {
    expect(resultado.diferencias.some((d) => d.sourceId === '1006')).toBe(
      false,
    );
  });

  it('el retiro y el impuesto suelto son de la cuenta, no de una distribuidora', () => {
    const [retiro] = tipos(resultado, MpDifferenceKind.PAYOUT);
    expect(retiro.accountLevel).toBe(true);
    expect(retiro.mpAmount?.toNumber()).toBe(9997);
    expect(retiro.extraAmount?.toNumber()).toBe(3);
    expect(retiro.needsCashBox).toBe(true);
    expect(retiro.appliable).toBe(true);

    const [impuesto] = tipos(resultado, MpDifferenceKind.TAX_ROW);
    expect(impuesto.accountLevel).toBe(true);
    expect(impuesto.mpAmount?.toNumber()).toBe(120);
    expect(impuesto.direction).toBe(CashDirection.OUT);
  });

  it('un cobro que no es de ninguna distribuidora se informa a la cuenta y no se asienta', () => {
    const [d] = tipos(resultado, MpDifferenceKind.UNKNOWN_PAYMENT);

    expect(d.sourceId).toBe('7777');
    expect(d.accountLevel).toBe(true);
    expect(d.appliable).toBe(false);
  });

  it('el cobro de otra distribuidora no deja ningún rastro', () => {
    expect(resultado.diferencias.some((d) => d.sourceId === '8888')).toBe(
      false,
    );
    expect(resultado.deOtrasDistribuidoras).toBe(1);
  });

  it('un ingreso de la caja que el reporte no trae se informa sin asentar nada', () => {
    const r = conciliar(
      entradaBase({
        ingresosDelRango: [
          pago('5555', { ingreso: ingreso(700) }),
          pago('1001', { ingreso: ingreso(1000) }),
        ],
      }),
    );

    const [d] = tipos(r, MpDifferenceKind.LEDGER_WITHOUT_MP);
    expect(d.sourceId).toBe('5555');
    expect(d.ledgerAmount?.toNumber()).toBe(700);
    expect(d.appliable).toBe(false);
    expect(tipos(r, MpDifferenceKind.LEDGER_WITHOUT_MP)).toHaveLength(1);
  });

  it('lo ya asentado por otra corrida no vuelve a aparecer', () => {
    const base = conciliar(entradaBase());
    const clave = base.diferencias.find(
      (d) => d.kind === MpDifferenceKind.TAX_WITHHOLDING,
    )?.rowKey as string;

    const r = conciliar(entradaBase({ aplicadas: new Set([clave]) }));

    expect(tipos(r, MpDifferenceKind.TAX_WITHHOLDING)).toHaveLength(0);
    expect(r.yaAsentadas).toBe(1);
    expect(r.diferencias).toHaveLength(base.diferencias.length - 1);
  });

  it('un cobro sin ingreso no ofrece asentar sus impuestos hasta asentar el cobro', () => {
    const r = conciliar(
      entradaBase({
        filas: parsearReporteDeLiberaciones(CSV_LIBERACIONES).rows.filter(
          (f) => f.sourceId === '1003',
        ),
        propios: new Map([['1003', pago('1003')]]),
        ingresosDelRango: [],
      }),
    );

    expect(tipos(r, MpDifferenceKind.TAX_WITHHOLDING)[0].appliable).toBe(false);
  });

  it('un movimiento desconocido del reporte se informa a la cuenta', () => {
    const fila = parsearReporteDeLiberaciones(CSV_LIBERACIONES).rows[0];
    const r = conciliar(
      entradaBase({
        filas: [
          {
            ...fila,
            sourceId: '31',
            description: 'reserve_for_dispute',
            netCredit: new Decimal(0),
            netDebit: new Decimal(75),
          },
        ],
        ingresosDelRango: [],
      }),
    );

    const [d] = tipos(r, MpDifferenceKind.OTHER_MOVEMENT);
    expect(d.accountLevel).toBe(true);
    expect(d.appliable).toBe(false);
    expect(d.direction).toBe(CashDirection.OUT);
  });
});

describe('claveDeFila', () => {
  const filas = parsearReporteDeLiberaciones(CSV_LIBERACIONES).rows;

  it('es un uuid estable para la misma fila y el mismo tipo', () => {
    const a = claveDeFila(MpDifferenceKind.TAX_WITHHOLDING, filas[2]);

    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(claveDeFila(MpDifferenceKind.TAX_WITHHOLDING, filas[2])).toBe(a);
  });

  it('cambia con el tipo de ajuste y con la fila', () => {
    const a = claveDeFila(MpDifferenceKind.TAX_WITHHOLDING, filas[2]);

    expect(claveDeFila(MpDifferenceKind.FEE_PENDING, filas[2])).not.toBe(a);
    expect(claveDeFila(MpDifferenceKind.TAX_WITHHOLDING, filas[3])).not.toBe(a);
  });
});

const fila = (texto: string) =>
  parsearReporteDeLiberaciones([ENCABEZADO_LIBERACIONES, texto].join('\n'))
    .rows;
const conFilas = (
  filas: string[],
  propios: PagoDelLibro[],
  cambios: Partial<EntradaDeConciliacion> = {},
) =>
  conciliar({
    filas: filas.flatMap(fila),
    propios: new Map(propios.map((p) => [p.gatewayPaymentId, p])),
    ajenos: new Set(),
    sinDistribuidora: new Set(),
    aplicadas: new Set(),
    ingresosDelRango: [],
    ...cambios,
  });
const F = (
  fecha: string,
  id: string,
  desc: string,
  cr: string,
  db: string,
  gross: string,
  fee: string,
  tax: string,
) =>
  `${fecha}T10:00:00.000-03:00;;${id};${desc};${cr};${db};${gross};${fee};${tax};visa;;;0;;`;

describe('conciliar: devolución total con reintegro', () => {
  it('la caja termina en lo que queda en Mercado Pago (la comisión y los impuestos devueltos no se cuentan dos veces)', () => {
    // Cobro 1000 (comisión 50, impuestos 20): neto 930. Devolución total: devuelve 1000 y MP reintegra 50 + 20 → sale 930.
    const p = pago('1', {
      ingreso: ingreso(1000),
      comision: new Decimal(70),
    });
    const r = conciliar({
      filas: fila(
        F(
          '2026-10-04',
          '1',
          'refund',
          '0.00',
          '930.00',
          '-1000.00',
          '50.00',
          '20.00',
        ),
      ),
      propios: new Map([['1', p]]),
      ajenos: new Set(),
      sinDistribuidora: new Set(),
      aplicadas: new Set(),
      ingresosDelRango: [],
    });

    const efecto = (d: {
      direction: CashDirection | null;
      mpAmount: Decimal | null;
    }) =>
      d.direction === CashDirection.IN
        ? (d.mpAmount?.toNumber() ?? 0)
        : -(d.mpAmount?.toNumber() ?? 0);
    const neto = r.diferencias.reduce((a, d) => a + efecto(d), 0);

    expect(r.diferencias.map((d) => d.kind).sort()).toEqual(
      [
        MpDifferenceKind.FEE_REIMBURSEMENT,
        MpDifferenceKind.REFUND_MISSING,
        MpDifferenceKind.TAX_REFUND,
      ].sort(),
    );
    // La caja tenía +1000 −70 de comisión (= 930); la devolución la deja en 0, igual que Mercado Pago.
    expect(1000 - 70 + neto).toBe(0 + 0);
  });

  it('una devolución que ya se pidió y está en curso desde acá no se egresa de nuevo', () => {
    const p = pago('1', {
      ingreso: ingreso(1000),
      devolucionComprometida: new Decimal(1000),
    });

    const r = conFilas(
      [
        F(
          '2026-10-04',
          '1',
          'refund',
          '0.00',
          '1000.00',
          '-1000.00',
          '0.00',
          '0.00',
        ),
      ],
      [p],
    );

    expect(tipos(r, MpDifferenceKind.REFUND_MISSING)).toHaveLength(0);
  });

  it('dos devoluciones parciales del mismo cobro son dos diferencias asentables', () => {
    const p = pago('1', { ingreso: ingreso(1000) });

    const r = conFilas(
      [
        F(
          '2026-10-04',
          '1',
          'refund',
          '0.00',
          '300.00',
          '-300.00',
          '0.00',
          '0.00',
        ),
        F(
          '2026-10-05',
          '1',
          'refund',
          '0.00',
          '200.00',
          '-200.00',
          '0.00',
          '0.00',
        ),
      ],
      [p],
    );

    const dev = tipos(r, MpDifferenceKind.REFUND_MISSING);
    expect(dev.map((d) => d.mpAmount?.toNumber())).toEqual([300, 200]);
    expect(dev.every((d) => d.appliable)).toBe(true);
    expect(new Set(dev.map((d) => d.rowKey)).size).toBe(2);
  });

  it('con una devolución parcial en curso, sólo falta lo que supera lo comprometido', () => {
    const p = pago('1', {
      ingreso: ingreso(1000),
      devolucionComprometida: new Decimal(300),
    });

    const r = conFilas(
      [
        F(
          '2026-10-04',
          '1',
          'refund',
          '0.00',
          '300.00',
          '-300.00',
          '0.00',
          '0.00',
        ),
        F(
          '2026-10-05',
          '1',
          'refund',
          '0.00',
          '200.00',
          '-200.00',
          '0.00',
          '0.00',
        ),
      ],
      [p],
    );

    expect(
      tipos(r, MpDifferenceKind.REFUND_MISSING).map((d) =>
        d.mpAmount?.toNumber(),
      ),
    ).toEqual([200]);
  });
});

describe('conciliar: comisión e impuestos', () => {
  it('si la comisión asentada ya incluye las retenciones (bruto menos neto), no hay diferencias', () => {
    const p = pago('1', { ingreso: ingreso(3000), comision: new Decimal(180) });

    const r = conFilas(
      [
        F(
          '2026-10-03',
          '1',
          'payment',
          '2820.00',
          '0.00',
          '3000.00',
          '-150.00',
          '-30.00',
        ),
      ],
      [p],
    );

    expect(r.diferencias).toEqual([]);
  });

  it('comisión y retenciones distintas de lo asentado se presentan juntas, una sola diferencia', () => {
    const p = pago('1', { ingreso: ingreso(3000), comision: new Decimal(100) });

    const r = conFilas(
      [
        F(
          '2026-10-03',
          '1',
          'payment',
          '2820.00',
          '0.00',
          '3000.00',
          '-150.00',
          '-30.00',
        ),
      ],
      [p],
    );

    expect(r.diferencias.map((d) => d.kind)).toEqual([
      MpDifferenceKind.FEE_MISMATCH,
    ]);
    expect(r.diferencias[0].mpAmount?.toNumber()).toBe(180);
    expect(r.diferencias[0].difference?.toNumber()).toBe(80);
  });

  it('con la comisión igual y retenciones sin egreso, sólo las retenciones', () => {
    const p = pago('1', { ingreso: ingreso(3000), comision: new Decimal(150) });

    const r = conFilas(
      [
        F(
          '2026-10-03',
          '1',
          'payment',
          '2820.00',
          '0.00',
          '3000.00',
          '-150.00',
          '-30.00',
        ),
      ],
      [p],
    );

    expect(r.diferencias.map((d) => d.kind)).toEqual([
      MpDifferenceKind.TAX_WITHHOLDING,
    ]);
  });

  it('varias filas de liberación del mismo cobro se comparan como una sola', () => {
    const p = pago('1', { ingreso: ingreso(1000), comision: new Decimal(50) });

    const r = conFilas(
      [
        F(
          '2026-10-03',
          '1',
          'payment',
          '475.00',
          '0.00',
          '500.00',
          '-25.00',
          '0.00',
        ),
        F(
          '2026-10-04',
          '1',
          'payment',
          '475.00',
          '0.00',
          '500.00',
          '-25.00',
          '0.00',
        ),
      ],
      [p],
    );

    expect(r.diferencias).toEqual([]);
  });

  it('la misma retención en el cobro y en una fila tax_ del mismo id no se asienta dos veces', () => {
    const p = pago('1', { ingreso: ingreso(3000), comision: new Decimal(150) });

    const r = conFilas(
      [
        F(
          '2026-10-03',
          '1',
          'payment',
          '2820.00',
          '0.00',
          '3000.00',
          '-150.00',
          '-30.00',
        ),
        F(
          '2026-10-03',
          '1',
          'tax_withholding',
          '0.00',
          '30.00',
          '-30.00',
          '0.00',
          '0.00',
        ),
      ],
      [p],
    );

    expect(tipos(r, MpDifferenceKind.TAX_WITHHOLDING)).toHaveLength(1);
    expect(tipos(r, MpDifferenceKind.TAX_ROW)).toHaveLength(0);
  });
});

describe('conciliar: cuenta y claves', () => {
  it('un pago del sistema sin distribuidora es un cobro desconocido de la cuenta', () => {
    const r = conFilas(
      [
        F(
          '2026-10-03',
          '9',
          'payment',
          '95.00',
          '0.00',
          '100.00',
          '-5.00',
          '0.00',
        ),
      ],
      [],
      { sinDistribuidora: new Set(['9']) },
    );

    expect(r.diferencias[0]).toMatchObject({
      kind: MpDifferenceKind.UNKNOWN_PAYMENT,
      accountLevel: true,
    });
    expect(r.diferencias[0].note).toMatch(/no tiene distribuidora/);
  });

  it('las filas de la cuenta ya asentadas se cuentan aparte de las de la distribuidora', () => {
    const base = conFilas(
      [
        F(
          '2026-10-05',
          '9001',
          'payout',
          '0.00',
          '100.00',
          '-100.00',
          '0.00',
          '0.00',
        ),
      ],
      [],
    );

    const r = conFilas(
      [
        F(
          '2026-10-05',
          '9001',
          'payout',
          '0.00',
          '100.00',
          '-100.00',
          '0.00',
          '0.00',
        ),
      ],
      [],
      { aplicadas: new Set([base.diferencias[0].rowKey]) },
    );

    expect(r.diferencias).toEqual([]);
    expect(r.yaAsentadasDeCuenta).toBe(1);
    expect(r.yaAsentadas).toBe(0);
  });

  it('la clave de la fila no depende de la zona horaria con que el reporte muestra la fecha', () => {
    const a = parsearReporteDeLiberaciones(
      [
        ENCABEZADO_LIBERACIONES,
        '2026-10-02T10:00:00.000-03:00;;1;payment;1;0;1;0;0;;;;0;;',
      ].join('\n'),
    ).rows[0];
    const b = parsearReporteDeLiberaciones(
      [
        ENCABEZADO_LIBERACIONES,
        '2026-10-02T08:00:00.000-05:00;;1;payment;1;0;1;0;0;;;;0;;',
      ].join('\n'),
    ).rows[0];

    expect(claveDeFila(MpDifferenceKind.FEE_PENDING, a)).toBe(
      claveDeFila(MpDifferenceKind.FEE_PENDING, b),
    );
  });
});
