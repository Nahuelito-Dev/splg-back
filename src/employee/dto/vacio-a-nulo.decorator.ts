import { Transform } from 'class-transformer';

/**
 * Un opcional que llega como texto vacío (el formulario del panel manda `""`
 * cuando el campo queda en blanco) se trata como no informado: `null` para
 * borrarlo en un PATCH, o `undefined` donde `null` no tiene sentido.
 */
export function VacioANulo(
  valorVacio: null | undefined = null,
): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() === '' ? valorVacio : value,
  );
}
