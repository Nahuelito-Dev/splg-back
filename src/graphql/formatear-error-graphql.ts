import { HttpException } from '@nestjs/common';
import { unwrapResolverError } from '@apollo/server/errors';
import { STATUS_CODES } from 'http';
import { GraphQLError, type GraphQLFormattedError } from 'graphql';

/** Los errores de Apollo que son del pedido (400 en HTTP), no del servidor. */
const ESTADO_POR_CODIGO_DE_APOLLO: Record<string, number> = {
  GRAPHQL_PARSE_FAILED: 400,
  GRAPHQL_VALIDATION_FAILED: 400,
  BAD_USER_INPUT: 400,
  OPERATION_RESOLUTION_FAILURE: 400,
  PERSISTED_QUERY_NOT_FOUND: 400,
  PERSISTED_QUERY_NOT_SUPPORTED: 400,
  BAD_REQUEST: 400,
};

/** El texto de un error que no es de Nest ni de GraphQL (igual que en REST). */
export const MENSAJE_ERROR_INTERNO = 'Error interno del servidor';

/** Lo que viaja en `extensions` de cada error de la API GraphQL. */
export interface ExtensionesDeError {
  /** Código estable en inglés: el de la API REST si lo tiene, o el del estado HTTP. */
  code: string;
  /** El estado HTTP que tendría la misma falla en la API REST. */
  statusCode: number;
}

/** `401` → `UNAUTHORIZED`, `403` → `FORBIDDEN`, … (el nombre del estado en mayúsculas). */
function codigoDelEstado(status: number): string {
  return (STATUS_CODES[status] ?? 'Error')
    .toUpperCase()
    .replace(/[^A-Z]+/g, '_')
    .replace(/^_|_$/g, '');
}

/** El texto y el `code` del cuerpo de una excepción de Nest (`{statusCode, message, error, code?}`). */
function desdeLaExcepcion(excepcion: HttpException): {
  message: string;
  code?: string;
} {
  const cuerpo = excepcion.getResponse();
  if (typeof cuerpo === 'string') return { message: cuerpo };
  const { message, code } = cuerpo as { message?: unknown; code?: unknown };
  const texto = Array.isArray(message)
    ? message.filter((m) => typeof m === 'string').join('. ')
    : typeof message === 'string'
      ? message
      : excepcion.message;
  return { message: texto, code: typeof code === 'string' ? code : undefined };
}

/**
 * Formato de los errores de la API GraphQL. Una falla de un resolver llega
 * acá como la excepción de Nest que ya tradujo `GlobalExceptionFilter`: sale
 * con el mismo texto en castellano que en REST y, en `extensions`, el `code`
 * en inglés (el de la API REST si lo tiene, como `PERMISSION_DENIED` o
 * `SUPPORT_SESSION_REQUIRED`; si no, el del estado: `UNAUTHORIZED`,
 * `BAD_REQUEST`) y el `statusCode` HTTP equivalente. Nunca viaja el stack ni
 * el error original.
 *
 * Los errores propios de GraphQL (sintaxis, un campo que no existe, los
 * límites de consulta) se dejan como los arma Apollo, sin el stack. Cualquier
 * otra cosa (no debería llegar: el filtro global traduce todo) sale como un
 * error interno, sin su texto.
 */
export function formatearErrorGraphql(
  formateado: GraphQLFormattedError,
  error: unknown,
): GraphQLFormattedError {
  const original = unwrapResolverError(error);
  if (original instanceof HttpException) {
    const status = original.getStatus();
    const { message, code } = desdeLaExcepcion(original);
    const extensions: ExtensionesDeError = {
      code: code ?? codigoDelEstado(status),
      statusCode: status,
    };
    return {
      message,
      locations: formateado.locations,
      path: formateado.path,
      extensions: { ...extensions },
    };
  }
  if (!(original instanceof GraphQLError)) {
    const extensions: ExtensionesDeError = {
      code: codigoDelEstado(500),
      statusCode: 500,
    };
    return {
      message: MENSAJE_ERROR_INTERNO,
      locations: formateado.locations,
      path: formateado.path,
      extensions: { ...extensions },
    };
  }
  const extensiones = { ...formateado.extensions };
  delete extensiones.stacktrace;
  // Apollo pisa el `code` de las reglas de validación propias (límites, sólo
  // lectura) con `GRAPHQL_VALIDATION_FAILED`: se recupera el de la regla.
  const propias =
    original.originalError instanceof GraphQLError
      ? original.originalError.extensions
      : original.extensions;
  const code =
    typeof propias.code === 'string' ? propias.code : extensiones.code;
  const statusCode =
    typeof propias.statusCode === 'number'
      ? propias.statusCode
      : ESTADO_POR_CODIGO_DE_APOLLO[String(code)];
  return {
    ...formateado,
    extensions: { ...extensiones, code, ...(statusCode ? { statusCode } : {}) },
  };
}
