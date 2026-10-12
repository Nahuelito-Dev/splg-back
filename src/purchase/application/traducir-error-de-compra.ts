import { ConflictException, Logger } from '@nestjs/common';
import {
  codigoSqlDelError,
  traducirErrorDeBase,
} from '../../common/errors/db-exceptions';

function restriccionDelError(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const driver: unknown = (error as Record<string, unknown>).driverError;
  if (typeof driver !== 'object' || driver === null) return undefined;
  const constraint: unknown = (driver as Record<string, unknown>).constraint;
  return typeof constraint === 'string' ? constraint : undefined;
}

/**
 * Los errores de base (carrera sobre un único, clave foránea) salen con un
 * mensaje claro; lo que no es de base —errores de dominio, excepciones HTTP—
 * se deja pasar tal cual.
 */
export function traducirErrorDeCompra(
  error: unknown,
  logger: Logger,
  contexto: string,
): never {
  if (codigoSqlDelError(error) === undefined) throw error;
  if (
    restriccionDelError(error) === 'UQ_purchase_receipt_documento_proveedor'
  ) {
    throw new ConflictException(
      'Ya hay una recepción de este proveedor con ese número de documento',
    );
  }
  return traducirErrorDeBase(error, logger, contexto);
}
