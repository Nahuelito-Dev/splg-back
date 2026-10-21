import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Largo máximo del serial grabado en el envase. */
export const SERIAL_MAXIMO = 100;

/**
 * Forma canónica del serial: sin espacios en los bordes y en mayúsculas, así
 * `ab-1 ` y `AB-1` son el mismo envase (la base lo garantiza con
 * `UQ_cylinder_serial_normalizado`).
 */
export function normalizarSerial(serial: string): string {
  return serial.trim().toUpperCase();
}

const normalizar = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? normalizarSerial(value) : value;

/** Serial obligatorio, recortado y en mayúsculas; "   " es lo mismo que vacío (400). */
export function SerialDeEnvase(): PropertyDecorator {
  return applyDecorators(
    Transform(normalizar),
    IsString(),
    IsNotEmpty({ message: 'El serial no puede estar vacío' }),
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
    MaxLength(SERIAL_MAXIMO, { each: true }),
  );
}
