import type { ParametrosDeRecupero } from './recovery-rules';

/** Banda de riesgo de un cliente para devolver sus envases a tiempo. */
export enum RecoveryRiskBand {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}

/**
 * Suavizado del puntaje: un cliente con pocas compras pesa poco frente al
 * valor neutro. Equivale a sumarle `PESO_DEL_NEUTRO` pedidos «de relleno» con
 * la tasa `PUNTAJE_NEUTRO`; con cero pedidos el puntaje es exactamente el neutro.
 */
export const PUNTAJE_NEUTRO = 0.15;
export const PESO_DEL_NEUTRO = 8;

/** Por debajo es banda baja; desde `UMBRAL_ALTO` (inclusive), alta; en el medio, media. */
export const UMBRAL_MEDIO = 0.08;
export const UMBRAL_ALTO = 0.25;

/**
 * Casos demorados históricos ÷ pedidos entregados, suavizada hacia el valor
 * neutro. Con pocas compras el puntaje queda cerca del neutro; con muchas, de la
 * tasa real del cliente.
 */
export function puntajeDelCliente(
  casosDemorados: number,
  pedidos: number,
): number {
  const crudo = casosDemorados + PUNTAJE_NEUTRO * PESO_DEL_NEUTRO;
  const puntaje = crudo / (pedidos + PESO_DEL_NEUTRO);
  return Math.round(puntaje * 10000) / 10000;
}

export function bandaDelPuntaje(puntaje: number): RecoveryRiskBand {
  if (puntaje >= UMBRAL_ALTO) return RecoveryRiskBand.HIGH;
  if (puntaje < UMBRAL_MEDIO) return RecoveryRiskBand.LOW;
  return RecoveryRiskBand.MEDIUM;
}

/** El cliente sin historia de casos: puntaje neutro y banda media. */
export const BANDA_SIN_HISTORIA = RecoveryRiskBand.MEDIUM;

const porcentajeDeLaTolerancia = (
  p: ParametrosDeRecupero,
  banda: RecoveryRiskBand,
): number =>
  banda === RecoveryRiskBand.LOW
    ? p.toleranceLowRiskPercent
    : banda === RecoveryRiskBand.HIGH
      ? p.toleranceHighRiskPercent
      : p.toleranceMediumRiskPercent;

const porcentajeDelEscalon = (
  p: ParametrosDeRecupero,
  banda: RecoveryRiskBand,
): number =>
  banda === RecoveryRiskBand.LOW
    ? p.stepLowRiskPercent
    : banda === RecoveryRiskBand.HIGH
      ? p.stepHighRiskPercent
      : p.stepMediumRiskPercent;

const diasAjustados = (dias: number, porcentaje: number): number =>
  Math.max(1, Math.round((dias * porcentaje) / 100));

/**
 * Los parámetros que rigen para un cliente de esa banda: `toleranceDays` y
 * `escalationStepDays` escalados por el porcentaje de la banda. Sólo cambian
 * los plazos (cuándo se avisa), nunca los importes.
 */
export function ajustarPorBanda(
  p: ParametrosDeRecupero,
  banda: RecoveryRiskBand | undefined,
): ParametrosDeRecupero {
  const b = banda ?? BANDA_SIN_HISTORIA;
  return {
    ...p,
    toleranceDays: diasAjustados(
      p.toleranceDays,
      porcentajeDeLaTolerancia(p, b),
    ),
    escalationStepDays: diasAjustados(
      p.escalationStepDays,
      porcentajeDelEscalon(p, b),
    ),
  };
}
