import { ValidationPipe, type ValidationPipeOptions } from '@nestjs/common';
import { fabricarExcepcionDeValidacion } from './traducir-validacion';

/**
 * El ValidationPipe de la API. `main.ts`, los tests de integración y los
 * specs lo arman desde acá para probar lo mismo que corre en producción.
 */
export function crearValidationPipe(
  opciones: ValidationPipeOptions = {},
): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: fabricarExcepcionDeValidacion,
    ...opciones,
  });
}
