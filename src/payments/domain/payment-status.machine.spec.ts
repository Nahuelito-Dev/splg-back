import { LedgerPaymentStatus as S } from './payment.enums';
import {
  estadoDelLedgerDesde,
  LEDGER_TRANSITIONS,
  montoCoincide,
  normalizarDetalleDelEstado,
  pagoCobrado,
  puedeTransicionarElPago,
} from './payment-status.machine';

describe('máquina de estados del pago (ledger)', () => {
  it('conoce exactamente los nueve estados de la API de pagos de Mercado Pago', () => {
    expect(Object.values(S).sort()).toEqual(
      [
        'approved',
        'authorized',
        'cancelled',
        'charged_back',
        'in_mediation',
        'in_process',
        'pending',
        'refunded',
        'rejected',
      ].sort(),
    );
  });

  it.each([
    [S.PENDING, S.IN_PROCESS],
    [S.PENDING, S.AUTHORIZED],
    [S.PENDING, S.APPROVED],
    [S.PENDING, S.REJECTED],
    [S.PENDING, S.CANCELLED],
    [S.PENDING, S.IN_MEDIATION],
    [S.PENDING, S.REFUNDED],
    [S.PENDING, S.CHARGED_BACK],
    [S.IN_PROCESS, S.APPROVED],
    [S.IN_PROCESS, S.REJECTED],
    [S.IN_PROCESS, S.CANCELLED],
    [S.IN_PROCESS, S.AUTHORIZED],
    [S.AUTHORIZED, S.APPROVED],
    [S.AUTHORIZED, S.CANCELLED],
    [S.AUTHORIZED, S.REJECTED],
    [S.AUTHORIZED, S.IN_PROCESS],
    [S.APPROVED, S.IN_MEDIATION],
    [S.APPROVED, S.REFUNDED],
    [S.APPROVED, S.CHARGED_BACK],
    [S.IN_MEDIATION, S.APPROVED],
    [S.IN_MEDIATION, S.CHARGED_BACK],
    [S.IN_MEDIATION, S.REFUNDED],
  ])('%s → %s está permitido', (desde, hacia) => {
    expect(puedeTransicionarElPago(desde, hacia)).toBe(true);
  });

  it.each([
    [S.APPROVED, S.PENDING],
    [S.APPROVED, S.IN_PROCESS],
    [S.APPROVED, S.AUTHORIZED],
    [S.APPROVED, S.REJECTED],
    [S.APPROVED, S.CANCELLED],
    [S.IN_PROCESS, S.PENDING],
    [S.IN_PROCESS, S.REFUNDED],
    [S.IN_PROCESS, S.IN_MEDIATION],
    [S.AUTHORIZED, S.PENDING],
    [S.IN_MEDIATION, S.PENDING],
    [S.IN_MEDIATION, S.REJECTED],
    [S.REJECTED, S.APPROVED],
    [S.REJECTED, S.PENDING],
    [S.REJECTED, S.IN_PROCESS],
    [S.CANCELLED, S.APPROVED],
    [S.REFUNDED, S.APPROVED],
    [S.REFUNDED, S.IN_MEDIATION],
    [S.REFUNDED, S.CHARGED_BACK],
    [S.REFUNDED, S.PENDING],
    [S.CHARGED_BACK, S.APPROVED],
    [S.CHARGED_BACK, S.IN_MEDIATION],
    [S.CHARGED_BACK, S.REFUNDED],
  ])('%s → %s no se permite: un pago no retrocede', (desde, hacia) => {
    expect(puedeTransicionarElPago(desde, hacia)).toBe(false);
  });

  it.each(Object.values(S))(
    'repetir %s es un no-op válido (reintento del webhook)',
    (estado) => {
      expect(puedeTransicionarElPago(estado, estado)).toBe(true);
    },
  );

  it('rechazado, cancelado, devuelto y contracargo son finales', () => {
    for (const final of [S.REJECTED, S.CANCELLED, S.REFUNDED, S.CHARGED_BACK]) {
      expect(LEDGER_TRANSITIONS[final]).toEqual([]);
    }
  });
});

describe('agrupaciones de estados', () => {
  it('cobrado: aprobado o con reclamo (la plata está acreditada)', () => {
    expect(pagoCobrado(S.APPROVED)).toBe(true);
    expect(pagoCobrado(S.IN_MEDIATION)).toBe(true);
    for (const otro of [S.PENDING, S.IN_PROCESS, S.REFUNDED, S.CHARGED_BACK]) {
      expect(pagoCobrado(otro)).toBe(false);
    }
  });

  it('un texto de MP que no es uno de los nueve se trata como pendiente', () => {
    expect(estadoDelLedgerDesde('in_mediation')).toBe(S.IN_MEDIATION);
    expect(estadoDelLedgerDesde('unknown')).toBe(S.PENDING);
    expect(estadoDelLedgerDesde('')).toBe(S.PENDING);
  });
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

describe('M-6: normalizarDetalleDelEstado', () => {
  it('vacío, en blanco o ausente es null (la base rechaza un motivo vacío)', () => {
    expect(normalizarDetalleDelEstado('')).toBeNull();
    expect(normalizarDetalleDelEstado('   ')).toBeNull();
    expect(normalizarDetalleDelEstado(null)).toBeNull();
    expect(normalizarDetalleDelEstado(undefined)).toBeNull();
  });

  it('recorta los espacios y el largo a lo que entra en la columna (100)', () => {
    expect(normalizarDetalleDelEstado(' accredited ')).toBe('accredited');
    expect(normalizarDetalleDelEstado('x'.repeat(150))).toHaveLength(100);
  });
});
