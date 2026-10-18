import { applyDecorators } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsNumber, Max, Min } from 'class-validator';

/** Tope de cualquier importe: entra en un `numeric(12,2)`. */
export const IMPORTE_MAXIMO = 9_999_999_999.99;

/**
 * Importe de dinero: número con a lo sumo dos decimales. Por omisión tiene que
 * ser mayor que cero (`minimo = 0.01`); `minimo: 0` admite el cero.
 */
export function Importe(minimo = 0.01): PropertyDecorator {
  return applyDecorators(
    Type(() => Number),
    IsNumber(
      { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 },
      { message: 'tiene que ser un importe con a lo sumo dos decimales' },
    ),
    Min(minimo, {
      message:
        minimo > 0 ? 'tiene que ser mayor que cero' : 'no puede ser negativo',
    }),
    Max(IMPORTE_MAXIMO),
  );
}
