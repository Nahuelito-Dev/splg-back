import { diaArgentino, diasEntre } from './dias-argentina';

/** Cómo le fue a una predicción de fechas, contra lo que pasó de verdad. */
export interface AciertoDePrediccion {
  /** Cuántas predicciones ya se pudieron comparar. */
  measured: number;
  /** Error medio absoluto, en días; `null` si no hay nada medido. */
  meanAbsoluteErrorDays: number | null;
  /** Qué parte de las medidas cayó dentro del margen, de 0 a 1; `null` si no hay nada medido. */
  withinMarginRate: number | null;
  /** Margen en días con el que se calculó `withinMarginRate`. */
  marginDays: number;
  /** Error medio con signo: positivo = pasó después de lo predicho; `null` si no hay nada medido. */
  meanBiasDays: number | null;
}

/** Error en días calendario argentinos: fecha real − fecha predicha (positivo = ocurrió después). */
export function errorEnDias(predicha: Date, real: Date): number {
  return diasEntre(diaArgentino(predicha), diaArgentino(real));
}

const redondear = (n: number): number => Math.round(n * 100) / 100;

/** Resume una lista de errores con signo en días. */
export function resumirAcierto(
  errores: readonly number[],
  margenEnDias: number,
): AciertoDePrediccion {
  const n = errores.length;
  if (n === 0) {
    return {
      measured: 0,
      meanAbsoluteErrorDays: null,
      withinMarginRate: null,
      marginDays: margenEnDias,
      meanBiasDays: null,
    };
  }
  const suma = (xs: number[]) => xs.reduce((a, x) => a + x, 0);
  return {
    measured: n,
    meanAbsoluteErrorDays: redondear(suma(errores.map(Math.abs)) / n),
    withinMarginRate: redondear(
      errores.filter((e) => Math.abs(e) <= margenEnDias).length / n,
    ),
    marginDays: margenEnDias,
    meanBiasDays: redondear(suma([...errores]) / n),
  };
}
