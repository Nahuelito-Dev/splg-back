import {
  cuentasDeRendicion,
  diferenciaDeRendicion,
  exigirEstado,
  resolucionDeDiferencia,
} from './driver-settlement-rules';
import {
  DifferenceResolution,
  DriverSettlementStatus,
} from './driver-settlement.enums';
import {
  RendicionEnOtroEstadoError,
  RendicionInvalidaError,
} from './errors/driver-settlement.errors';

describe('reglas de la rendición del chofer', () => {
  describe('exigirEstado', () => {
    it('presentar sólo desde abierta', () => {
      expect(() =>
        exigirEstado(DriverSettlementStatus.OPEN, 'submit'),
      ).not.toThrow();
      expect(() =>
        exigirEstado(DriverSettlementStatus.SUBMITTED, 'submit'),
      ).toThrow(RendicionEnOtroEstadoError);
      expect(() =>
        exigirEstado(DriverSettlementStatus.APPROVED, 'submit'),
      ).toThrow(RendicionEnOtroEstadoError);
    });

    it('aprobar y reabrir sólo desde presentada', () => {
      for (const accion of ['approve', 'reopen'] as const) {
        expect(() =>
          exigirEstado(DriverSettlementStatus.SUBMITTED, accion),
        ).not.toThrow();
        expect(() => exigirEstado(DriverSettlementStatus.OPEN, accion)).toThrow(
          RendicionEnOtroEstadoError,
        );
        expect(() =>
          exigirEstado(DriverSettlementStatus.APPROVED, accion),
        ).toThrow(RendicionEnOtroEstadoError);
      }
    });

    it('el mensaje de una aprobada dice que no se reabre', () => {
      expect(() =>
        exigirEstado(DriverSettlementStatus.APPROVED, 'reopen'),
      ).toThrow(/aprobada.*presentada/);
    });
  });

  describe('diferenciaDeRendicion', () => {
    it('es declarado + gastos − esperado', () => {
      expect(diferenciaDeRendicion(900, 100, 1000).toString()).toBe('0');
      expect(diferenciaDeRendicion(800, 100, 1000).toString()).toBe('-100');
      expect(diferenciaDeRendicion(1100, 0, 1000).toString()).toBe('100');
    });

    it('no pierde centavos', () => {
      expect(diferenciaDeRendicion('0.1', '0.2', '0.3').isZero()).toBe(true);
    });
  });

  describe('cuentasDeRendicion', () => {
    it('suma los gastos y calcula la diferencia con ellos', () => {
      const c = cuentasDeRendicion(900, [60, '40.50'], 1000);
      expect(c.gastos.toString()).toBe('100.5');
      expect(c.diferencia.toString()).toBe('0.5');
    });

    it('sin gastos es declarado − esperado', () => {
      const c = cuentasDeRendicion(800, [], 1000);
      expect(c.gastos.isZero()).toBe(true);
      expect(c.diferencia.toString()).toBe('-200');
    });

    it('no pierde centavos al sumar', () => {
      expect(
        cuentasDeRendicion(0, ['0.1', '0.2'], '0.3').diferencia.isZero(),
      ).toBe(true);
    });
  });

  describe('resolucionDeDiferencia', () => {
    it('sin diferencia no hay nada que resolver, se pida lo que se pida', () => {
      expect(resolucionDeDiferencia(0, undefined)).toBe(
        DifferenceResolution.NONE,
      );
      expect(resolucionDeDiferencia(0, DifferenceResolution.ABSORBED)).toBe(
        DifferenceResolution.NONE,
      );
    });

    it('con diferencia hay que decidir (400)', () => {
      expect(() => resolucionDeDiferencia(-50, undefined)).toThrow(
        RendicionInvalidaError,
      );
      expect(() =>
        resolucionDeDiferencia(-50, DifferenceResolution.NONE),
      ).toThrow(RendicionInvalidaError);
    });

    it('un faltante puede quedar a cargo del chofer o absorberse', () => {
      expect(
        resolucionDeDiferencia(-50, DifferenceResolution.CHARGED_TO_DRIVER),
      ).toBe(DifferenceResolution.CHARGED_TO_DRIVER);
      expect(resolucionDeDiferencia(-50, DifferenceResolution.ABSORBED)).toBe(
        DifferenceResolution.ABSORBED,
      );
    });

    it('un sobrante no se le descuenta al chofer', () => {
      expect(() =>
        resolucionDeDiferencia(50, DifferenceResolution.CHARGED_TO_DRIVER),
      ).toThrow(RendicionInvalidaError);
      expect(resolucionDeDiferencia(50, DifferenceResolution.ABSORBED)).toBe(
        DifferenceResolution.ABSORBED,
      );
    });
  });
});
