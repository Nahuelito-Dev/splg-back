import Decimal from 'decimal.js';
import { sumarDias } from '../../common/utils/dias-argentina';

/** Tope de cuotas de un plan (cinco años mensuales). */
export const MAXIMO_DE_CUOTAS = 60;

export interface PlanDeCuotas {
  count: number;
  /** Importe de cada cuota. */
  amount: Decimal.Value;
  /** Vencimiento de la primera, `YYYY-MM-DD`; las demás caen el mismo día de cada mes. */
  firstDueDate: string;
  graceDays: number;
}

export interface CuotaGenerada {
  number: number;
  total: number;
  /** `YYYY-MM-DD` */
  dueDate: string;
  /** `YYYY-MM-DD`: hasta cuándo el pago se juzga en término. */
  graceUntil: string;
  amount: Decimal;
}

function ultimoDiaDelMes(anio: number, mes: number): number {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}

/**
 * El vencimiento de la cuota `indice` (0 = la primera): el mismo día del mes de
 * la primera, o el último del mes si ese mes no lo tiene (una cuota del 31 cae
 * el 28 o 29 en febrero y el 30 en abril; el día original se conserva para los
 * meses siguientes).
 */
export function vencimientoDeLaCuota(
  primerVencimiento: string,
  indice: number,
): string {
  const [anio, mes, dia] = primerVencimiento.split('-').map(Number);
  const meses = mes - 1 + indice;
  const anioDeLaCuota = anio + Math.floor(meses / 12);
  const mesDeLaCuota = (meses % 12) + 1;
  const diaDeLaCuota = Math.min(
    dia,
    ultimoDiaDelMes(anioDeLaCuota, mesDeLaCuota),
  );
  return `${anioDeLaCuota}-${String(mesDeLaCuota).padStart(2, '0')}-${String(diaDeLaCuota).padStart(2, '0')}`;
}

/** Las cuotas mensuales de un plan, con su gracia. Función pura. */
export function generarCuotas(plan: PlanDeCuotas): CuotaGenerada[] {
  const importe = new Decimal(plan.amount);
  return Array.from({ length: plan.count }, (_, i) => {
    const dueDate = vencimientoDeLaCuota(plan.firstDueDate, i);
    return {
      number: i + 1,
      total: plan.count,
      dueDate,
      graceUntil: sumarDias(dueDate, plan.graceDays),
      amount: importe,
    };
  });
}
