import { applyDecorators } from '@nestjs/common';
import {
  Matches,
  MaxLength,
  MinLength,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';
import { esContrasenaComun } from './contrasenas-comunes';

/** Largo mínimo y máximo de toda contraseña nueva o cambiada. */
export const LARGO_MINIMO_CONTRASENA = 8;
export const LARGO_MAXIMO_CONTRASENA = 128;

export const MENSAJE_POLITICA_CONTRASENA =
  'La contraseña tiene que tener entre 8 y 128 caracteres, una mayúscula, una minúscula y un número';
export const MENSAJE_CONTRASENA_COMUN =
  'Esa contraseña es muy común: elegí otra';

/**
 * Política de contraseñas (decisión 6 de auth): de 8 a 128 caracteres, una
 * mayúscula, una minúscula y un número; se aceptan espacios y cualquier carácter; se rechazan
 * las contraseñas comunes (lista embebida, sin distinguir mayúsculas). Vale
 * para toda contraseña nueva o cambiada; las cuentas actuales no se fuerzan.
 */
export function cumplePoliticaDeContrasena(valor: unknown): boolean {
  return (
    typeof valor === 'string' &&
    valor.length >= LARGO_MINIMO_CONTRASENA &&
    valor.length <= LARGO_MAXIMO_CONTRASENA &&
    /\p{Lu}/u.test(valor) &&
    /\p{Ll}/u.test(valor) &&
    /\d/.test(valor) &&
    !esContrasenaComun(valor)
  );
}

function NoEsContrasenaComun(opciones?: ValidationOptions): PropertyDecorator {
  return (objeto, propiedad) =>
    registerDecorator({
      name: 'noEsContrasenaComun',
      target: objeto.constructor,
      propertyName: propiedad as string,
      options: { message: MENSAJE_CONTRASENA_COMUN, ...opciones },
      validator: {
        validate: (valor: unknown) =>
          typeof valor !== 'string' || !esContrasenaComun(valor),
      },
    });
}

/**
 * Validador compartido para los DTO con una contraseña nueva. Combinalo con
 * `@IsString()`/`@IsOptional()` según el campo.
 */
export function EsContrasenaSegura(): PropertyDecorator {
  const message = MENSAJE_POLITICA_CONTRASENA;
  return applyDecorators(
    MinLength(LARGO_MINIMO_CONTRASENA, { message }),
    MaxLength(LARGO_MAXIMO_CONTRASENA, { message }),
    Matches(/\p{Lu}/u, { message }),
    Matches(/\p{Ll}/u, { message }),
    Matches(/\d/, { message }),
    NoEsContrasenaComun(),
  );
}
