import { parametrosDeRecupero } from './recovery-rules';
import {
  ajustarPorBanda,
  bandaDelPuntaje,
  PESO_DEL_NEUTRO,
  PUNTAJE_NEUTRO,
  puntajeDelCliente,
  RecoveryRiskBand,
  UMBRAL_ALTO,
  UMBRAL_MEDIO,
} from './riesgo-de-recupero';
import { PARAMETROS } from '../recovery-test-kit';

describe('riesgo de recupero', () => {
  const P = parametrosDeRecupero(PARAMETROS);

  describe('puntajeDelCliente', () => {
    it('un cliente sin casos ni pedidos tiene exactamente el puntaje neutro', () => {
      expect(puntajeDelCliente(0, 0)).toBe(PUNTAJE_NEUTRO);
    });

    it('con pocas compras pesa poco: un caso en un pedido queda lejos de 1', () => {
      const p = puntajeDelCliente(1, 1);
      expect(p).toBeCloseTo(
        (1 + 0.15 * PESO_DEL_NEUTRO) / (1 + PESO_DEL_NEUTRO),
        4,
      );
      expect(p).toBeLessThan(0.3);
    });

    it('con muchas compras se acerca a la tasa real del cliente', () => {
      expect(puntajeDelCliente(50, 100)).toBeCloseTo(0.4741, 3);
      expect(puntajeDelCliente(0, 200)).toBeLessThan(0.01);
    });

    it('más demoras con los mismos pedidos nunca baja el puntaje', () => {
      expect(puntajeDelCliente(3, 10)).toBeGreaterThan(
        puntajeDelCliente(2, 10),
      );
    });
  });

  describe('bandaDelPuntaje (los bordes importan)', () => {
    it.each([
      [0, RecoveryRiskBand.LOW],
      [UMBRAL_MEDIO - 0.0001, RecoveryRiskBand.LOW],
      [UMBRAL_MEDIO, RecoveryRiskBand.MEDIUM],
      [UMBRAL_ALTO - 0.0001, RecoveryRiskBand.MEDIUM],
      [UMBRAL_ALTO, RecoveryRiskBand.HIGH],
      [1, RecoveryRiskBand.HIGH],
    ])('el puntaje %s es banda %s', (puntaje, banda) => {
      expect(bandaDelPuntaje(puntaje)).toBe(banda);
    });

    it('el neutro cae en la banda media', () => {
      expect(bandaDelPuntaje(PUNTAJE_NEUTRO)).toBe(RecoveryRiskBand.MEDIUM);
    });

    it('un cliente con demoras reiteradas queda en banda alta y uno puntual en baja', () => {
      expect(bandaDelPuntaje(puntajeDelCliente(5, 10))).toBe(
        RecoveryRiskBand.HIGH,
      );
      expect(bandaDelPuntaje(puntajeDelCliente(0, 40))).toBe(
        RecoveryRiskBand.LOW,
      );
    });
  });

  describe('ajustarPorBanda', () => {
    it('banda alta acorta los plazos según el porcentaje configurado', () => {
      const r = ajustarPorBanda(P, RecoveryRiskBand.HIGH);
      expect(r.toleranceDays).toBe(21);
      expect(r.escalationStepDays).toBe(5);
    });

    it('banda baja da más margen en la tolerancia', () => {
      const r = ajustarPorBanda(P, RecoveryRiskBand.LOW);
      expect(r.toleranceDays).toBe(36);
      expect(r.escalationStepDays).toBe(7);
    });

    it('banda media y cliente sin historia dejan los plazos como están', () => {
      expect(ajustarPorBanda(P, RecoveryRiskBand.MEDIUM)).toEqual(P);
      expect(ajustarPorBanda(P, undefined)).toEqual(P);
    });

    it('usa el porcentaje de cada banda por separado', () => {
      const q = {
        ...P,
        toleranceHighRiskPercent: 50,
        stepHighRiskPercent: 200,
        toleranceLowRiskPercent: 200,
        stepLowRiskPercent: 50,
      };
      expect(ajustarPorBanda(q, RecoveryRiskBand.HIGH)).toEqual(
        expect.objectContaining({ toleranceDays: 15, escalationStepDays: 14 }),
      );
      expect(ajustarPorBanda(q, RecoveryRiskBand.LOW)).toEqual(
        expect.objectContaining({ toleranceDays: 60, escalationStepDays: 4 }),
      );
    });

    it('nunca baja de un día y no toca el resto de los parámetros (ni los importes)', () => {
      const r = ajustarPorBanda(
        { ...P, toleranceDays: 1, toleranceHighRiskPercent: 10 },
        RecoveryRiskBand.HIGH,
      );
      expect(r.toleranceDays).toBe(1);
      expect(r.escalationAmountThreshold).toBe(P.escalationAmountThreshold);
      expect(r.pickupOfferTtlHours).toBe(P.pickupOfferTtlHours);
    });
  });
});
