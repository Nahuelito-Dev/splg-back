import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Texto libre obligatorio: se recorta antes de validar, así que "   " es lo
 * mismo que vacío y se rechaza con 400. Lo que se guarda ya viene recortado.
 */
export function TextoNoVacio(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.trim() : value,
    ),
    IsString(),
    IsNotEmpty(),
  );
}
