import { LedgerPaymentStatus as S } from './payment.enums';
import {
  montoCoincide,
  puedeTransicionarElPago,
} from './payment-status.machine';

describe('máquina de estados del pago (ledger)', () => {
  it.each([
    [S.PENDING, S.APPROVED],
    [S.PENDING, S.REJECTED],
    [S.PENDING, S.CANCELLED],
    [S.PENDING, S.REFUNDED],
    [S.APPROVED, S.REFUNDED],
  ])('%s → %s está permitido', (desde, hacia) => {
    expect(puedeTransicionarElPago(desde, hacia)).toBe(true);
  });

  it.each([
    [S.APPROVED, S.PENDING],
    [S.APPROVED, S.REJECTED],
    [S.APPROVED, S.CANCELLED],
    [S.REJECTED, S.APPROVED],
    [S.REJECTED, S.PENDING],
    [S.CANCELLED, S.APPROVED],
    [S.REFUNDED, S.APPROVED],
    [S.REFUNDED, S.PENDING],
  ])('%s → %s no se permite: un pago no retrocede', (desde, hacia) => {
    expect(puedeTransicionarElPago(desde, hacia)).toBe(false);
  });

  it.each(Object.values(S))(
    'repetir %s es un no-op válido (reintento del webhook)',
    (estado) => {
      expect(puedeTransicionarElPago(estado, estado)).toBe(true);
    },
  );
});

describe('montoCoincide', () => {
  it('lo cobrado igual a lo esperado coincide', () => {
    expect(montoCoincide(15000, 15000)).toBe(true);
    expect(montoCoincide(1670.5, 1670.5)).toBe(true);
  });

  it('un centavo de diferencia ya no coincide', () => {
    expect(montoCoincide(15000, 14999.99)).toBe(false);
    expect(montoCoincide(15000, 15000.01)).toBe(false);
  });

  it('una diferencia grande no coincide', () => {
    expect(montoCoincide(15000, 1500)).toBe(false);
    expect(montoCoincide(15000, 0)).toBe(false);
  });

  it('el ruido de punto flotante no cuenta', () => {
    expect(montoCoincide(0.1 + 0.2, 0.3)).toBe(true);
  });
});
