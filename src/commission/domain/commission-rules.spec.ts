import {
  calcularComision,
  exigirEstadoDeLiquidacion,
  ReglaDeComision,
  reglaGanadora,
  rigeEl,
  seSolapan,
  validarRegla,
} from './commission-rules';
import { CommissionBasis, LiquidationStatus } from './commission.enums';
import {
  ComisionConflictoError,
  ComisionInvalidaError,
} from './errors/commission.errors';

const regla = (
  r: Partial<ReglaDeComision> & { ruleId: string },
): ReglaDeComision => ({
  employeeId: null,
  gasCylinderId: null,
  basis: CommissionBasis.PER_UNIT,
  value: 10,
  validFrom: '2026-01-01',
  validTo: null,
  ...r,
});

describe('reglas de comisión', () => {
  describe('rigeEl', () => {
    it('ambos extremos son inclusivos y sin fin es abierto', () => {
      const r = regla({
        ruleId: 'r',
        validFrom: '2026-10-01',
        validTo: '2026-10-31',
      });
      expect(rigeEl(r, '2026-09-30')).toBe(false);
      expect(rigeEl(r, '2026-10-01')).toBe(true);
      expect(rigeEl(r, '2026-10-31')).toBe(true);
      expect(rigeEl(r, '2026-11-01')).toBe(false);
      expect(rigeEl(regla({ ruleId: 'x' }), '2099-01-01')).toBe(true);
    });
  });

  describe('reglaGanadora', () => {
    const general = regla({ ruleId: 'general' });
    const deProducto = regla({ ruleId: 'producto', gasCylinderId: 'g1' });
    const deEmpleado = regla({ ruleId: 'empleado', employeeId: 'e1' });
    const deAmbos = regla({
      ruleId: 'ambos',
      employeeId: 'e1',
      gasCylinderId: 'g1',
    });
    const todas = [general, deProducto, deEmpleado, deAmbos];

    it('empleado y producto > empleado > producto > general', () => {
      expect(reglaGanadora(todas, 'e1', 'g1', '2026-10-10')?.ruleId).toBe(
        'ambos',
      );
      expect(reglaGanadora(todas, 'e1', 'g2', '2026-10-10')?.ruleId).toBe(
        'empleado',
      );
      expect(reglaGanadora(todas, 'e2', 'g1', '2026-10-10')?.ruleId).toBe(
        'producto',
      );
      expect(reglaGanadora(todas, 'e2', 'g2', '2026-10-10')?.ruleId).toBe(
        'general',
      );
    });

    it('ignora las que apuntan a otro empleado o a otro producto, o que no rigen', () => {
      const vencida = regla({ ruleId: 'vieja', validTo: '2026-01-31' });
      expect(reglaGanadora([deEmpleado], 'e2', 'g1', '2026-10-10')).toBeNull();
      expect(reglaGanadora([vencida], 'e1', 'g1', '2026-10-10')).toBeNull();
    });
  });

  describe('calcularComision', () => {
    it('por unidad: valor × cantidad', () => {
      const r = calcularComision(
        [regla({ ruleId: 'u', value: 150 })],
        'e1',
        '2026-10-10',
        [{ gasCylinderId: 'g1', quantity: 3, subtotal: 3000 }],
      );
      expect(r.total.toString()).toBe('450');
      expect(r.lineas).toHaveLength(1);
      expect(r.lineas[0]).toMatchObject({
        ruleId: 'u',
        amount: 450,
        quantity: 3,
      });
    });

    it('por pedido: el valor una sola vez aunque haya varios renglones', () => {
      const r = calcularComision(
        [regla({ ruleId: 'p', basis: CommissionBasis.PER_ORDER, value: 200 })],
        'e1',
        '2026-10-10',
        [
          { gasCylinderId: 'g1', quantity: 1, subtotal: 1000 },
          { gasCylinderId: 'g2', quantity: 2, subtotal: 2000 },
        ],
      );
      expect(r.total.toString()).toBe('200');
    });

    it('porcentaje del subtotal, redondeado a centavos mitad hacia arriba', () => {
      const r = calcularComision(
        [
          regla({
            ruleId: 'pc',
            basis: CommissionBasis.PERCENT_OF_TOTAL,
            value: 3.5,
          }),
        ],
        'e1',
        '2026-10-10',
        [{ gasCylinderId: 'g1', quantity: 1, subtotal: 1234.57 }],
      );
      // 1234.57 × 3.5 / 100 = 43.21 (43.21 exacto: 43.2099…)
      expect(r.lineas[0].amount).toBe(43.21);
      expect(r.total.toString()).toBe('43.21');
    });

    it('cada renglón usa su regla: un producto con regla propia y el resto con la general', () => {
      const r = calcularComision(
        [
          regla({ ruleId: 'general', value: 100 }),
          regla({ ruleId: 'g1', gasCylinderId: 'g1', value: 250 }),
        ],
        'e1',
        '2026-10-10',
        [
          { gasCylinderId: 'g1', quantity: 2, subtotal: 0 },
          { gasCylinderId: 'g2', quantity: 3, subtotal: 0 },
        ],
      );
      expect(r.lineas.map((l) => [l.ruleId, l.amount])).toEqual([
        ['g1', 500],
        ['general', 300],
      ]);
      expect(r.total.toString()).toBe('800');
    });

    it('sin regla vigente no hay líneas', () => {
      const r = calcularComision([], 'e1', '2026-10-10', [
        { gasCylinderId: 'g1', quantity: 1, subtotal: 1000 },
      ]);
      expect(r.lineas).toEqual([]);
      expect(r.total.isZero()).toBe(true);
    });

    it('la suma de mil asientos coincide con la de los importes redondeados', () => {
      const reglas = [
        regla({
          ruleId: 'pc',
          basis: CommissionBasis.PERCENT_OF_TOTAL,
          value: 1.15,
        }),
      ];
      let suma = 0;
      let sumaRedondeada = 0;
      for (let i = 0; i < 1000; i++) {
        const subtotal = 1000 + i * 0.37;
        const r = calcularComision(reglas, 'e1', '2026-10-10', [
          { gasCylinderId: 'g1', quantity: 1, subtotal },
        ]);
        sumaRedondeada += r.lineas[0].amount * 100;
        suma += r.total.times(100).toNumber();
      }
      expect(Math.round(suma)).toBe(Math.round(sumaRedondeada));
    });
  });

  describe('validarRegla', () => {
    const base = {
      basis: CommissionBasis.PER_UNIT,
      value: 10,
      validFrom: '2026-10-01',
      validTo: null,
    };

    it('rechaza un valor negativo, un porcentaje mayor a 100 y una vigencia al revés', () => {
      expect(() => validarRegla({ ...base, value: -1 })).toThrow(
        ComisionInvalidaError,
      );
      expect(() =>
        validarRegla({
          ...base,
          basis: CommissionBasis.PERCENT_OF_TOTAL,
          value: 100.01,
        }),
      ).toThrow(ComisionInvalidaError);
      expect(() => validarRegla({ ...base, validTo: '2026-09-30' })).toThrow(
        ComisionInvalidaError,
      );
    });

    it('acepta 100 por ciento y valor cero', () => {
      expect(() =>
        validarRegla({
          ...base,
          basis: CommissionBasis.PERCENT_OF_TOTAL,
          value: 100,
        }),
      ).not.toThrow();
      expect(() => validarRegla({ ...base, value: 0 })).not.toThrow();
    });
  });

  describe('seSolapan', () => {
    const a = {
      employeeId: 'e1',
      gasCylinderId: null,
      validFrom: '2026-10-01',
      validTo: '2026-10-31',
    };

    it('rangos que se tocan en un día se solapan (extremos inclusivos)', () => {
      expect(
        seSolapan(a, { ...a, validFrom: '2026-10-31', validTo: null }),
      ).toBe(true);
    });

    it('rangos consecutivos no se solapan', () => {
      expect(
        seSolapan(a, { ...a, validFrom: '2026-11-01', validTo: null }),
      ).toBe(false);
    });

    it('un rango abierto se solapa con cualquiera posterior', () => {
      expect(
        seSolapan(
          { ...a, validTo: null },
          { ...a, validFrom: '2030-01-01', validTo: null },
        ),
      ).toBe(true);
    });

    it('distinto alcance nunca se solapa', () => {
      expect(seSolapan(a, { ...a, employeeId: null })).toBe(false);
      expect(seSolapan(a, { ...a, gasCylinderId: 'g1' })).toBe(false);
    });
  });

  describe('exigirEstadoDeLiquidacion', () => {
    it('aprobar sólo un borrador; pagar sólo una aprobada; anular borrador o aprobada', () => {
      expect(() =>
        exigirEstadoDeLiquidacion(LiquidationStatus.DRAFT, 'approve'),
      ).not.toThrow();
      expect(() =>
        exigirEstadoDeLiquidacion(LiquidationStatus.APPROVED, 'approve'),
      ).toThrow(ComisionConflictoError);
      expect(() =>
        exigirEstadoDeLiquidacion(LiquidationStatus.APPROVED, 'pay'),
      ).not.toThrow();
      expect(() =>
        exigirEstadoDeLiquidacion(LiquidationStatus.DRAFT, 'pay'),
      ).toThrow(ComisionConflictoError);
      expect(() =>
        exigirEstadoDeLiquidacion(LiquidationStatus.DRAFT, 'void'),
      ).not.toThrow();
      expect(() =>
        exigirEstadoDeLiquidacion(LiquidationStatus.APPROVED, 'void'),
      ).not.toThrow();
    });

    it('anular el pago sólo corresponde a una pagada', () => {
      expect(() =>
        exigirEstadoDeLiquidacion(LiquidationStatus.PAID, 'unpay'),
      ).not.toThrow();
      for (const estado of [
        LiquidationStatus.DRAFT,
        LiquidationStatus.APPROVED,
        LiquidationStatus.VOIDED,
      ]) {
        expect(() => exigirEstadoDeLiquidacion(estado, 'unpay')).toThrow(
          ComisionConflictoError,
        );
      }
    });

    it('una pagada no se anula directo y el mensaje manda a anular primero el pago', () => {
      expect(() =>
        exigirEstadoDeLiquidacion(LiquidationStatus.PAID, 'void'),
      ).toThrow(/anulá primero el pago/);
      expect(() =>
        exigirEstadoDeLiquidacion(LiquidationStatus.VOIDED, 'void'),
      ).toThrow(ComisionConflictoError);
    });
  });
});
