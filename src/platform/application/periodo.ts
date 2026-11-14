import { BadRequestException } from '@nestjs/common';
import {
  diaArgentino,
  diasEntre,
  inicioDelDiaArgentino,
  primerDiaDelMes,
  primerDiaDelMesSiguiente,
  rangoDeDiasArgentinos,
} from '../../common/utils/dias-argentina';

/** Un período del tablero: días argentinos `from`..`to` (inclusive) y sus instantes `[desde, hasta)`. */
export interface Periodo {
  from: string;
  to: string;
  desde: Date;
  hasta: Date;
}

/** Un mes calendario argentino (`YYYY-MM`) y sus instantes `[desde, hasta)`. */
export interface Mes {
  month: string;
  desde: Date;
  hasta: Date;
}

/** El período más largo que se agrega de una vez (un año y un día, por los bisiestos). */
export const PERIODO_MAXIMO_DIAS = 366;

/**
 * El período de las métricas de plataforma. Sin `from` ni `to`, el mes en curso
 * hasta hoy (hora argentina); con uno solo, desde ese día hasta hoy o desde el
 * primero de ese mes hasta ese día. Mismo corte que los reportes de cada
 * empresa (`/v2/reports/sales-summary`): `desde` inclusive, `hasta` exclusivo.
 */
export function periodoDe(
  from: string | undefined,
  to: string | undefined,
  ahora: Date = new Date(),
): Periodo {
  const hoy = diaArgentino(ahora);
  const hasta = to ?? hoy;
  const desde = from ?? primerDiaDelMes(hasta);
  const rango = rangoDeDiasArgentinos(desde, hasta);
  if (!rango) {
    throw new BadRequestException('Las fechas tienen que ser AAAA-MM-DD');
  }
  if (desde > hasta) {
    throw new BadRequestException(
      'La fecha «desde» no puede ser posterior a la fecha «hasta»',
    );
  }
  if (diasEntre(desde, hasta) + 1 > PERIODO_MAXIMO_DIAS) {
    throw new BadRequestException(
      `El período puede abarcar hasta ${PERIODO_MAXIMO_DIAS} días`,
    );
  }
  return { from: desde, to: hasta, desde: rango.desde, hasta: rango.hasta };
}

/** El mes `YYYY-MM` (por omisión, el mes en curso en Argentina). */
export function mesDe(
  month: string | undefined,
  ahora: Date = new Date(),
): Mes {
  const primero = month ? `${month}-01` : primerDiaDelMes(diaArgentino(ahora));
  const desde = inicioDelDiaArgentino(primero);
  const hasta = desde
    ? inicioDelDiaArgentino(primerDiaDelMesSiguiente(primero))
    : null;
  if (!desde || !hasta) {
    throw new BadRequestException('El mes tiene que ser AAAA-MM');
  }
  return { month: primero.slice(0, 7), desde, hasta };
}
