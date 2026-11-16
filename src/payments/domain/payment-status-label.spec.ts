import { LedgerPaymentStatus as S } from './payment.enums';
import { etiquetaDelPago, RECHAZO_GENERICO } from './payment-status-label';

describe('etiquetaDelPago', () => {
  it('«Rechazado por el banco» es el texto genérico de un rechazo', () => {
    expect(RECHAZO_GENERICO).toBe('Rechazado por el banco');
    expect(etiquetaDelPago(S.REJECTED, null)).toBe('Rechazado por el banco');
    expect(etiquetaDelPago(S.REJECTED, undefined)).toBe(
      'Rechazado por el banco',
    );
    expect(etiquetaDelPago(S.REJECTED, 'un_codigo_que_mp_inventa')).toBe(
      'Rechazado por el banco',
    );
    expect(etiquetaDelPago(S.REJECTED, 'cc_rejected_other_reason')).toBe(
      'Rechazado por el banco',
    );
  });

  it.each([
    [
      'cc_rejected_insufficient_amount',
      'Fondos insuficientes en el medio de pago',
    ],
    ['cc_rejected_bad_filled_card_number', 'Revisá el número de la tarjeta'],
    [
      'cc_rejected_bad_filled_date',
      'Revisá la fecha de vencimiento de la tarjeta',
    ],
    [
      'cc_rejected_bad_filled_security_code',
      'Revisá el código de seguridad de la tarjeta',
    ],
    [
      'cc_rejected_call_for_authorize',
      'Tenés que autorizar el pago con tu banco o tarjeta',
    ],
    [
      'cc_rejected_high_risk',
      'Rechazado por seguridad: probá con otro medio de pago',
    ],
    [
      'cc_rejected_max_attempts',
      'Llegaste al límite de intentos: usá otra tarjeta u otro medio de pago',
    ],
  ])('rechazo %s → «%s»', (detalle, texto) => {
    expect(etiquetaDelPago(S.REJECTED, detalle)).toBe(texto);
  });

  it('el motivo de un rechazo no se aplica a otro estado', () => {
    expect(etiquetaDelPago(S.APPROVED, 'cc_rejected_insufficient_amount')).toBe(
      'Pago acreditado',
    );
  });

  it.each([
    [S.PENDING, null, 'Esperando el pago'],
    [S.PENDING, 'pending_waiting_payment', 'Esperando que completes el pago'],
    [
      S.IN_PROCESS,
      'pending_review_manual',
      'Pago en revisión: te avisamos en menos de 2 días hábiles',
    ],
    [S.IN_PROCESS, null, 'Pago en revisión'],
    [
      S.AUTHORIZED,
      'pending_capture',
      'Pago autorizado, pendiente de confirmación',
    ],
    [S.APPROVED, 'accredited', 'Pago acreditado'],
    [
      S.APPROVED,
      'partially_refunded',
      'Pago acreditado, con una devolución parcial',
    ],
    [S.CANCELLED, 'expired', 'Pago vencido: pasó el plazo para pagar'],
    [S.CANCELLED, 'by_payer', 'Pago cancelado por quien pagaba'],
    [S.CANCELLED, null, 'Pago cancelado'],
    [S.REFUNDED, 'refunded', 'Pago devuelto'],
    [S.CHARGED_BACK, 'settled', 'Contracargo: el dinero quedó retenido'],
    [S.CHARGED_BACK, null, 'Contracargo sobre el pago'],
    [S.IN_MEDIATION, 'pending', 'Reclamo en curso sobre el pago'],
  ])('%s con %s → «%s»', (estado, detalle, texto) => {
    expect(etiquetaDelPago(estado, detalle)).toBe(texto);
  });

  it('todos los estados tienen texto', () => {
    for (const estado of Object.values(S)) {
      expect(etiquetaDelPago(estado, null)).toBeTruthy();
    }
  });
});
