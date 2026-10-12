import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Motivo obligatorio (cancelar una orden, anular un remito), con los errores en castellano. */
export function MotivoObligatorio(max = 500): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.trim() : value,
    ),
    IsString({ message: 'reason: tiene que ser un texto' }),
    IsNotEmpty({ message: 'reason: el motivo es obligatorio' }),
    MaxLength(max, { message: `reason: hasta ${max} caracteres` }),
  );
}
