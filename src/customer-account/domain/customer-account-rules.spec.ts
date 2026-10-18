import Decimal from 'decimal.js';
import { AgingBucket, CustomerEntryType } from './customer-account.enums';
import {
  creditoDisponible,
  diasEntre,
  imputarFifo,
  rangoDeAntiguedad,
  saldoDespuesDelAsiento,
  signoDelAsiento,
  vencimientoDe,
} from './customer-account-rules';

const asiento = (entryId: string, pendiente: number) => ({
  entryId,
  pendiente: new Decimal(pendiente),
});

describe('reglas de la cuenta corriente', () => {
  it('cargos y notas de débito suben la deuda; pagos y notas de crédito la bajan', () => {
    expect(signoDelAsiento(CustomerEntryType.SALE_CHARGE)).toBe(1);
    expect(signoDelAsiento(CustomerEntryType.DEBIT_NOTE)).toBe(1);
    expect(signoDelAsiento(CustomerEntryType.PAYMENT)).toBe(-1);
    expect(signoDelAsiento(CustomerEntryType.CREDIT_NOTE)).toBe(-1);
  });

  it('el saldo se mueve con aritmética decimal exacta', () => {
    const tras = saldoDespuesDelAsiento(
      0.1,
      CustomerEntryType.SALE_CHARGE,
      0.2,
    );
    expect(tras.toString()).toBe('0.3');
    expect(
      saldoDespuesDelAsiento(tras, CustomerEntryType.PAYMENT, '0.30').isZero(),
    ).toBe(true);
  });

  describe('creditoDisponible', () => {
    it('es límite − saldo − pedidos a cuenta abiertos', () => {
      expect(creditoDisponible(100000, 30000, 20000).toString()).toBe('50000');
    });

    it('puede quedar negativo si el cliente se pasó', () => {
      expect(creditoDisponible(1000, 900, 300).toString()).toBe('-200');
    });
  });

  it('el vencimiento es la entrega más el plazo, cruzando meses y años', () => {
    expect(vencimientoDe('2026-11-15', 30)).toBe('2026-12-15');
    expect(vencimientoDe('2026-12-20', 30)).toBe('2027-01-19');
  });

  it('diasEntre cuenta días calendario', () => {
    expect(diasEntre('2026-10-01', '2026-10-31')).toBe(30);
    expect(diasEntre('2026-12-31', '2027-01-01')).toBe(1);
  });

  it('rangoDeAntiguedad reparte en 0-30, 31-60, 61-90 y más de 90', () => {
    expect(rangoDeAntiguedad(0)).toBe(AgingBucket.D0_30);
    expect(rangoDeAntiguedad(30)).toBe(AgingBucket.D0_30);
    expect(rangoDeAntiguedad(31)).toBe(AgingBucket.D31_60);
    expect(rangoDeAntiguedad(60)).toBe(AgingBucket.D31_60);
    expect(rangoDeAntiguedad(61)).toBe(AgingBucket.D61_90);
    expect(rangoDeAntiguedad(90)).toBe(AgingBucket.D61_90);
    expect(rangoDeAntiguedad(91)).toBe(AgingBucket.D90_PLUS);
  });

  describe('imputarFifo', () => {
    it('un pago salda primero el cargo más viejo', () => {
      const r = imputarFifo(
        [asiento('c1', 100), asiento('c2', 100)],
        [asiento('p1', 150)],
      );
      expect(r.map((i) => [i.debitEntryId, i.amount.toString()])).toEqual([
        ['c1', '100'],
        ['c2', '50'],
      ]);
    });

    it('varios pagos se reparten sobre lo que queda pendiente', () => {
      const r = imputarFifo(
        [asiento('c1', 100), asiento('c2', 100)],
        [asiento('p1', 60), asiento('p2', 60)],
      );
      expect(
        r.map((i) => [i.creditEntryId, i.debitEntryId, i.amount.toString()]),
      ).toEqual([
        ['p1', 'c1', '60'],
        ['p2', 'c1', '40'],
        ['p2', 'c2', '20'],
      ]);
    });

    it('un pago mayor a la deuda deja el resto sin imputar', () => {
      const r = imputarFifo([asiento('c1', 100)], [asiento('p1', 500)]);
      expect(r).toHaveLength(1);
      expect(r[0].amount.toString()).toBe('100');
    });

    it('sin cargos pendientes no imputa nada', () => {
      expect(imputarFifo([], [asiento('p1', 100)])).toEqual([]);
      expect(imputarFifo([asiento('c1', 0)], [asiento('p1', 100)])).toEqual([]);
    });

    it('la suma de lo imputado nunca supera lo pendiente de cada lado', () => {
      const cargos = [
        asiento('c1', 33.33),
        asiento('c2', 66.67),
        asiento('c3', 10),
      ];
      const creditos = [asiento('p1', 50), asiento('p2', 40.01)];
      const r = imputarFifo(cargos, creditos);
      const total = r.reduce((s, i) => s.plus(i.amount), new Decimal(0));
      expect(total.toString()).toBe('90.01');
    });
  });
});
