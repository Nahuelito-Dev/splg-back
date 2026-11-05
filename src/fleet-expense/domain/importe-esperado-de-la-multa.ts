import Decimal from 'decimal.js';
import { diaArgentino } from '../../common/utils/dias-argentina';

interface MultaConImportes {
  amount: number;
  voluntaryPaymentAmount: number | null;
  dueDate: string | null;
}

/** El importe voluntario sólo aplica hasta su vencimiento inclusive. */
export function importeEsperadoDeLaMulta(
  multa: MultaConImportes,
  hoy = diaArgentino(),
): string {
  const voluntarioVigente =
    multa.voluntaryPaymentAmount !== null &&
    (multa.dueDate === null || multa.dueDate >= hoy);
  return new Decimal(
    voluntarioVigente
      ? (multa.voluntaryPaymentAmount ?? multa.amount)
      : multa.amount,
  ).toFixed(2);
}
