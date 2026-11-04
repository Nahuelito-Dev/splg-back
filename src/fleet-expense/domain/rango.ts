import { BadRequestException } from '@nestjs/common';
import {
  inicioDelDiaArgentino,
  rangoDelDiaArgentino,
} from '../../common/utils/dias-argentina';

/** `[desde, hasta)` en instantes; cualquiera de los dos puede faltar. */
export interface RangoOpcional {
  desde?: Date;
  hasta?: Date;
}

/**
 * Los filtros `from` y `to` (`YYYY-MM-DD`, inclusivos, en hora argentina) como
 * instantes. 400 si `from` es posterior a `to`.
 */
export function rangoDeFiltros(from?: string, to?: string): RangoOpcional {
  const desde = from ? (inicioDelDiaArgentino(from) ?? undefined) : undefined;
  const hasta = to ? rangoDelDiaArgentino(to)?.hasta : undefined;
  if (from && !desde) {
    throw new BadRequestException('Desde: no es una fecha válida (YYYY-MM-DD)');
  }
  if (to && !hasta) {
    throw new BadRequestException('Hasta: no es una fecha válida (YYYY-MM-DD)');
  }
  if (desde && hasta && desde >= hasta) {
    throw new BadRequestException(
      'Desde: la fecha de inicio no puede ser posterior a la de fin',
    );
  }
  return { desde, hasta };
}

/** Un rango obligatorio de días: 400 si es inválido, invertido o de más de cinco años. */
export function rangoDeDias(from: string, to: string, maximoDeDias: number) {
  const { desde, hasta } = rangoDeFiltros(from, to);
  if (!desde || !hasta) {
    throw new BadRequestException('from y to son obligatorios');
  }
  const dias = Math.round((hasta.getTime() - desde.getTime()) / 86_400_000);
  if (dias > maximoDeDias) {
    throw new BadRequestException(
      `El rango no puede superar ${maximoDeDias} días`,
    );
  }
  return { desde, hasta };
}
