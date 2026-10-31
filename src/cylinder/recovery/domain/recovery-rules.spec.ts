import {
  avisoDelEscalon,
  destinoAlAgotarse,
  siguientePaso,
  superaLaTolerancia,
  vencimientoDelEscalon,
  vencimientoDeLaOferta,
  parametrosDeRecupero,
} from './recovery-rules';
import { RecoveryCaseStatus } from '../../entities/cylinder-recovery-case.entity';
import { RecoveryNoticeKind } from '../../entities/cylinder-recovery-notice.entity';

const DIA = 24 * 60 * 60 * 1000;
const AHORA = new Date('2026-10-31T12:00:00Z');
const P = parametrosDeRecupero({
  toleranceDays: 30,
  escalationStepDays: 7,
  escalationAmountThreshold: 50000,
  pickupOfferTtlHours: 72,
  pickupWindowDays: 7,
  runHour: 4,
});

describe('recovery-rules', () => {
  describe('superaLaTolerancia', () => {
    it('no pasa un día antes del plazo y pasa justo en el plazo', () => {
      const antes = new Date(AHORA.getTime() - 29 * DIA);
      const justo = new Date(AHORA.getTime() - 30 * DIA);
      expect(superaLaTolerancia(antes, AHORA, 30)).toBe(false);
      expect(superaLaTolerancia(justo, AHORA, 30)).toBe(true);
    });
  });

  it('el primer escalón es el recordatorio y el segundo el aviso del depósito', () => {
    expect(avisoDelEscalon(1)).toBe(RecoveryNoticeKind.REMINDER);
    expect(avisoDelEscalon(2)).toBe(RecoveryNoticeKind.DEPOSIT_WARNING);
  });

  it('los vencimientos salen de los parámetros', () => {
    expect(vencimientoDelEscalon(AHORA, P).getTime()).toBe(
      AHORA.getTime() + 7 * DIA,
    );
    expect(vencimientoDeLaOferta(AHORA, P).getTime()).toBe(
      AHORA.getTime() + 72 * 60 * 60 * 1000,
    );
  });

  describe('siguientePaso', () => {
    const vence = new Date(AHORA.getTime() + DIA);
    const vencido = new Date(AHORA.getTime() - 1);

    it('sin aviso en el escalón, avisa aunque el plazo no haya vencido', () => {
      expect(
        siguientePaso({ step: 1, stepDueAt: vence }, false, AHORA),
      ).toEqual({ accion: 'avisar', step: 1 });
    });

    it('con el aviso enviado y plazo vigente, espera (idempotente)', () => {
      expect(siguientePaso({ step: 1, stepDueAt: vence }, true, AHORA)).toEqual(
        {
          accion: 'esperar',
        },
      );
    });

    it('vencido el primer escalón sube al segundo', () => {
      expect(
        siguientePaso({ step: 1, stepDueAt: vencido }, true, AHORA),
      ).toEqual({ accion: 'subir', step: 2 });
    });

    it('vencido el segundo escalón agota la secuencia', () => {
      expect(
        siguientePaso({ step: 2, stepDueAt: vencido }, true, AHORA),
      ).toEqual({ accion: 'agotar' });
    });

    it('el vencimiento exacto ya cuenta como vencido', () => {
      expect(siguientePaso({ step: 1, stepDueAt: AHORA }, true, AHORA)).toEqual(
        { accion: 'subir', step: 2 },
      );
    });
  });

  describe('destinoAlAgotarse', () => {
    it('escala sólo si el depósito SUPERA el umbral', () => {
      expect(destinoAlAgotarse(50000.01, 50000)).toBe(
        RecoveryCaseStatus.ESCALATED,
      );
      expect(destinoAlAgotarse(50000, 50000)).toBe(RecoveryCaseStatus.LOST);
      expect(destinoAlAgotarse(0, 50000)).toBe(RecoveryCaseStatus.LOST);
    });
  });
});
