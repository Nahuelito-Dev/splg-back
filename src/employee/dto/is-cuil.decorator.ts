import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, ValidateBy } from 'class-validator';
import { esCuilValido, normalizarCuil } from '../domain/cuil';

/**
 * CUIL opcional: se normaliza a once dígitos (acepta guiones) y se valida el
 * dígito verificador. `null` lo borra en el PATCH.
 */
export function Cuil(valorVacio: null | undefined = null): PropertyDecorator {
  return applyDecorators(
    ApiPropertyOptional({
      type: String,
      example: '20123456786',
      description: 'Once dígitos; se valida el dígito verificador',
      nullable: true,
    }),
    IsOptional(),
    Transform(({ value }: { value: unknown }) => {
      if (typeof value !== 'string') return value;
      const limpio = normalizarCuil(value);
      return limpio === '' ? valorVacio : limpio;
    }),
    ValidateBy({
      name: 'isCuil',
      validator: {
        validate: (valor: unknown) =>
          typeof valor === 'string' && esCuilValido(valor),
        defaultMessage: () =>
          'cuil no es válido: son 11 dígitos con el dígito verificador correcto',
      },
    }),
  );
}
