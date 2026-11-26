import { errorEnDias } from '../../common/utils/acierto-de-prediccion';
import {
  diaArgentino,
  inicioDelDiaArgentino,
} from '../../common/utils/dias-argentina';
import {
  EstimacionDeRecompra,
  RepurchaseEstimateSource,
} from './estimacion-de-recompra';

const MS_POR_DIA = 86_400_000;
const MS_POR_HORA = 3_600_000;

/** Tope del ajuste por cliente: nunca corre la fecha más de esto, para un lado ni para el otro. */
export const OFFSET_MAXIMO_DIAS = 15;
/** Invitaciones medidas mínimas para que el ajuste valga: con una sola es azar. */
export const MEDIDAS_MINIMAS_DEL_OFFSET = 2;
/** Cuántas de las últimas invitaciones medidas cuentan: el ritmo de hoy, no el de hace un año. */
export const MEDIDAS_MAXIMAS_DEL_OFFSET = 6;
/** Lo que tiene que quedarle de vigencia a una invitación después del aviso. */
export const VIGENCIA_MINIMA_TRAS_EL_AVISO_MS = 2 * MS_POR_HORA;

/**
 * El ajuste de un cliente: el error medio (en días, con signo) de sus
 * invitaciones anteriores medidas contra su fecha base, redondeado y acotado.
 * Con menos de `MEDIDAS_MINIMAS_DEL_OFFSET` medidas no hay ajuste.
 */
export function calcularOffset(errores: readonly number[]): number {
  const medidas = errores.slice(0, MEDIDAS_MAXIMAS_DEL_OFFSET);
  if (medidas.length < MEDIDAS_MINIMAS_DEL_OFFSET) return 0;
  const media = medidas.reduce((a, e) => a + e, 0) / medidas.length;
  const acotado = Math.max(
    -OFFSET_MAXIMO_DIAS,
    Math.min(OFFSET_MAXIMO_DIAS, Math.round(media)),
  );
  return acotado === 0 ? 0 : acotado;
}

/** Error (días) de una invitación medido contra su fecha base: sin el ajuste que ya llevaba. */
export function errorContraLaBase(
  predicha: Date,
  offsetAplicado: number,
  real: Date,
): number {
  return errorEnDias(
    new Date(predicha.getTime() - offsetAplicado * MS_POR_DIA),
    real,
  );
}

/**
 * El ajuste sólo rige donde el ritmo propio no alcanza: con el consumo
 * declarado, o con una historia que apenas llega al mínimo de compras. Con más
 * historia, el ritmo propio ya corrige lo que el ajuste corregiría.
 */
export function aplicaElOffset(
  estimacion: Pick<EstimacionDeRecompra, 'source' | 'ordersUsed'>,
  minOrders: number,
): boolean {
  return (
    estimacion.source === RepurchaseEstimateSource.DECLARED ||
    estimacion.ordersUsed <= minOrders
  );
}

/** La estimación con el ajuste del cliente aplicado, si corresponde; `aplicado` dice cuántos días se corrió. */
export function aplicarOffset(
  estimacion: EstimacionDeRecompra,
  offsetDays: number,
  minOrders: number,
): { estimacion: EstimacionDeRecompra; aplicado: number } {
  const dias = Math.max(
    -OFFSET_MAXIMO_DIAS,
    Math.min(OFFSET_MAXIMO_DIAS, Math.trunc(offsetDays)),
  );
  if (dias === 0 || !aplicaElOffset(estimacion, minOrders)) {
    return { estimacion, aplicado: 0 };
  }
  return {
    estimacion: {
      ...estimacion,
      estimatedAt: new Date(
        estimacion.estimatedAt.getTime() + dias * MS_POR_DIA,
      ),
    },
    aplicado: dias,
  };
}

/**
 * Cuándo se le avisa al cliente de su invitación: al comienzo de su franja de
 * hoy (`franjaDesde`, `HH:MM`) o, si no tiene franja, si la franja ya empezó o
 * si el aviso dejaría la invitación casi sin vigencia, ahora mismo (la hora de
 * la corrida). Siempre antes del vencimiento.
 */
export function momentoDelAviso(
  ahora: Date,
  vence: Date,
  franjaDesde: string | null,
): Date {
  if (!franjaDesde) return ahora;
  const m = /^(\d{2}):(\d{2})/.exec(franjaDesde);
  const inicioDelDia = inicioDelDiaArgentino(diaArgentino(ahora));
  if (!m || !inicioDelDia) return ahora;
  const deLaFranja = new Date(
    inicioDelDia.getTime() + (Number(m[1]) * 60 + Number(m[2])) * 60_000,
  );
  if (deLaFranja.getTime() <= ahora.getTime()) return ahora;
  if (
    deLaFranja.getTime() + VIGENCIA_MINIMA_TRAS_EL_AVISO_MS >
    vence.getTime()
  ) {
    return ahora;
  }
  return deLaFranja;
}
