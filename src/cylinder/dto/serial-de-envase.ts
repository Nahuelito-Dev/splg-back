import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { SERIAL_MAXIMO, normalizarSerial } from '../domain/serial-de-envase';

export { SERIAL_MAXIMO, normalizarSerial };

const normalizar = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? normalizarSerial(value) : value;

/** Serial obligatorio, recortado y en mayúsculas; "   " es lo mismo que vacío (400). */
export function SerialDeEnvase(): PropertyDecorator {
  return applyDecorators(
    Transform(normalizar),
    IsString(),
    IsNotEmpty({ message: 'El serial no puede estar vacío' }),
    Matches(/\S/, { message: 'El serial no puede estar vacío' }),
    MaxLength(SERIAL_MAXIMO),
  );
}

/** Una lista de seriales, cada uno recortado y en mayúsculas. */
export function SerialesDeEnvase(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      Array.isArray(value) ? value.map((v) => normalizar({ value: v })) : value,
    ),
    IsString({ each: true }),
    IsNotEmpty({ each: true, message: 'Los seriales no pueden estar vacíos' }),
    Matches(/\S/, {
      each: true,
      message: 'Los seriales no pueden estar vacíos',
    }),
    MaxLength(SERIAL_MAXIMO, { each: true }),
  );
}
