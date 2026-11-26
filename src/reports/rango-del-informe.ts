import { BadRequestException } from '@nestjs/common';
import {
  diaArgentino,
  rangoDeDiasArgentinos,
} from '../common/utils/dias-argentina';

export interface RangoDelInforme {
  startDate: Date;
  endDate: Date;
  from: string;
  to: string;
}

/**
 * `startDate` inclusive y `endDate` EXCLUSIVO: `[inicio de from, inicio del
 * día siguiente a to)` en hora argentina.
 */
export function rangoDelInforme(from?: string, to?: string): RangoDelInforme {
  // Sin from/to: hoy en hora argentina. Con uno solo, el rango es ese día.
  const hoy = diaArgentino();
  const desde = from ?? to ?? hoy;
  const hasta = to ?? from ?? hoy;
  const rango = rangoDeDiasArgentinos(desde, hasta);

  if (!rango) {
    throw new BadRequestException('Las fechas tienen que ser YYYY-MM-DD');
  }
  if (desde > hasta) {
    throw new BadRequestException('from no puede ser posterior a to');
  }

  return {
    startDate: rango.desde,
    endDate: rango.hasta,
    from: desde,
    to: hasta,
  };
}
