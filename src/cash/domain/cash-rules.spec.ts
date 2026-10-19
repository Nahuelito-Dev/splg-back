import Decimal from 'decimal.js';
import {
  CashBoxKind,
  CashDirection,
  CashReferenceType,
  CategoryDirection,
} from './cash.enums';
import {
  arqueo,
  categoriaCoincideConElSentido,
  dejaSaldoNegativoEnEfectivo,
  motivoDeNoAnulable,
  requiereSesionPorOmision,
  saldoDespuesDe,
  sentidoOpuesto,
} from './cash-rules';

describe('reglas de la caja', () => {
  describe('saldoDespuesDe', () => {
    it('suma las entradas y resta las salidas sin errores de coma flotante', () => {
      expect(saldoDespuesDe(0.1, CashDirection.IN, 0.2).toString()).toBe('0.3');
      expect(
        saldoDespuesDe('100.10', CashDirection.OUT, '0.30').toString(),
      ).toBe('99.8');
    });

    it('mil movimientos de centavos suman exacto', () => {
      let saldo = new Decimal(0);
      for (let i = 0; i < 1000; i++) {
        saldo = saldoDespuesDe(saldo, CashDirection.IN, 0.01);
      }
      expect(saldo.toString()).toBe('10');
    });
  });

  describe('dejaSaldoNegativoEnEfectivo', () => {
    it('una caja de efectivo no puede quedar en negativo', () => {
      expect(dejaSaldoNegativoEnEfectivo(CashBoxKind.CASH, -0.01)).toBe(true);
      expect(dejaSaldoNegativoEnEfectivo(CashBoxKind.CASH, 0)).toBe(false);
    });

    it('el banco y la billetera sí admiten saldo negativo', () => {
      expect(dejaSaldoNegativoEnEfectivo(CashBoxKind.BANK, -500)).toBe(false);
      expect(dejaSaldoNegativoEnEfectivo(CashBoxKind.WALLET, -500)).toBe(false);
    });
  });

  describe('categoriaCoincideConElSentido', () => {
    it('una entrada va con ingresos y una salida con gastos', () => {
      expect(
        categoriaCoincideConElSentido(
          CashDirection.IN,
          CategoryDirection.INCOME,
        ),
      ).toBe(true);
      expect(
        categoriaCoincideConElSentido(
          CashDirection.IN,
          CategoryDirection.EXPENSE,
        ),
      ).toBe(false);
      expect(
        categoriaCoincideConElSentido(
          CashDirection.OUT,
          CategoryDirection.EXPENSE,
        ),
      ).toBe(true);
      expect(
        categoriaCoincideConElSentido(
          CashDirection.OUT,
          CategoryDirection.INCOME,
        ),
      ).toBe(false);
    });
  });

  it('sentidoOpuesto invierte el sentido', () => {
    expect(sentidoOpuesto(CashDirection.IN)).toBe(CashDirection.OUT);
    expect(sentidoOpuesto(CashDirection.OUT)).toBe(CashDirection.IN);
  });

  describe('arqueo', () => {
    it('lo esperado es apertura + entradas − salidas', () => {
      const r = arqueo(5000, 2000, 1000, 6000);
      expect(r.esperado.toString()).toBe('6000');
      expect(r.diferencia.toString()).toBe('0');
    });

    it('un faltante da diferencia negativa y un sobrante positiva', () => {
      expect(arqueo(5000, 2000, 1000, 5500).diferencia.toString()).toBe('-500');
      expect(arqueo(5000, 2000, 1000, 6100).diferencia.toString()).toBe('100');
    });

    it('con centavos no pierde precisión', () => {
      expect(arqueo('0.10', '0.20', 0, '0.30').diferencia.isZero()).toBe(true);
    });
  });

  it('el efectivo exige sesión por omisión; banco y billetera no', () => {
    expect(requiereSesionPorOmision(CashBoxKind.CASH)).toBe(true);
    expect(requiereSesionPorOmision(CashBoxKind.BANK)).toBe(false);
    expect(requiereSesionPorOmision(CashBoxKind.WALLET)).toBe(false);
  });

  describe('motivoDeNoAnulable', () => {
    it('un movimiento manual se anula', () => {
      expect(motivoDeNoAnulable(CashReferenceType.MANUAL)).toBeNull();
    });

    it.each([
      [CashReferenceType.BOX_TRANSFER, /reverse-transfer/],
      [CashReferenceType.DRIVER_LIQUIDATION, /unpay/],
      [CashReferenceType.CUSTOMER_PAYMENT, /ajuste en la cuenta corriente/],
      [CashReferenceType.DRIVER_SETTLEMENT, /rendición/],
      [CashReferenceType.SESSION_OPENING, /sesión/],
      [CashReferenceType.SESSION_CLOSING, /sesión/],
      [CashReferenceType.PURCHASE_RECEIPT, /payment-status/],
      [CashReferenceType.FUEL_LOAD, /anulando la carga/],
      [CashReferenceType.TRAFFIC_FINE, /multa pagada no se anula/],
      [CashReferenceType.ORDER_PAYMENT, /transferencia entre cajas \(CU-310\)/],
      [CashReferenceType.ORDER_PAYMENT, /ajuste o egreso manual con motivo/],
      [CashReferenceType.REVERSAL, /anulación/],
    ])(
      '%s no se anula desde movimientos y dice por dónde se corrige',
      (tipo, texto) => {
        expect(motivoDeNoAnulable(tipo)).toMatch(texto);
      },
    );
  });
});
