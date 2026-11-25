import { BadRequestException, ConflictException } from '@nestjs/common';
import { EnvasesVencidosException } from '../cylinder-vencido.exception';
import {
  EnvaseEnConflictoError,
  EnvasesVencidosError,
  ReglaDeEnvaseError,
} from '../domain/errors/cylinder-rule.errors';

/**
 * Lleva los errores del dominio de envases a la excepción que la API ya
 * respondía (mismo status, texto y cuerpo). El dominio no conoce HTTP; quien
 * llama a los casos de uso sigue recibiendo lo de siempre. Lo que no es un
 * error de este dominio pasa tal cual (una transición inválida la mapea el
 * filtro global).
 */
export function aExcepcionHttp(error: unknown): unknown {
  if (error instanceof EnvasesVencidosError) {
    return new EnvasesVencidosException(error.serials);
  }
  if (error instanceof ReglaDeEnvaseError) {
    return new BadRequestException(error.message);
  }
  if (error instanceof EnvaseEnConflictoError) {
    return new ConflictException(error.message);
  }
  return error;
}

/** Corre `trabajo` y traduce los errores del dominio de envases. */
export async function conErroresHttp<T>(trabajo: () => Promise<T>): Promise<T> {
  try {
    return await trabajo();
  } catch (error) {
    throw aExcepcionHttp(error);
  }
}
