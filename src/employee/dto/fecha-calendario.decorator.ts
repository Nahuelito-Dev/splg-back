import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VacioANulo } from './vacio-a-nulo.decorator';
import { IsISO8601, IsOptional, Matches } from 'class-validator';

const SOLO_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MENSAJE = 'tiene que ser una fecha real con formato YYYY-MM-DD';

/** Fecha de calendario `YYYY-MM-DD` (sin hora ni zona). */
export function FechaCalendario(ejemplo = '2026-03-01'): PropertyDecorator {
  return applyDecorators(
    ApiProperty({ example: ejemplo, format: 'date' }),
    Matches(SOLO_FECHA, { message: MENSAJE }),
    IsISO8601({ strict: true }, { message: MENSAJE }),
  );
}

export function FechaCalendarioOpcional(
  ejemplo = '1990-05-17',
  valorVacio: null | undefined = null,
): PropertyDecorator {
  return applyDecorators(
    VacioANulo(valorVacio),
    ApiPropertyOptional({ example: ejemplo, format: 'date', nullable: true }),
    IsOptional(),
    Matches(SOLO_FECHA, { message: MENSAJE }),
    IsISO8601({ strict: true }, { message: MENSAJE }),
  );
}
