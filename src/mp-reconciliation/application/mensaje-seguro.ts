import { HttpException } from '@nestjs/common';
import { DomainError } from '../../common/errors/domain.error';

/**
 * El mensaje que se le puede mostrar a quien usa el panel: el de una excepción
 * HTTP o de dominio (escrito para personas). Cualquier otra cosa (un error de
 * Postgres, de red, un bug) queda en el log y al cliente le llega un texto propio.
 */
export function mensajeSeguro(error: unknown): string {
  if (error instanceof HttpException) {
    const respuesta = error.getResponse();
    if (typeof respuesta === 'string') return respuesta;
    if (typeof respuesta === 'object' && respuesta !== null) {
      const { message } = respuesta as { message?: unknown };
      if (typeof message === 'string') return message;
      if (Array.isArray(message)) return message.map(String).join('. ');
    }
    return error.message;
  }
  if (error instanceof DomainError) return error.message;
  return 'Error interno: se registró en el servidor';
}
