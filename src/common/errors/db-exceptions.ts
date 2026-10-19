import {
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DomainError } from './domain.error';

/**
 * Códigos de error de Postgres que sabemos traducir.
 * https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const CODIGOS = {
  UNICO_VIOLADO: '23505',
  CLAVE_FORANEA: '23503',
  NO_NULO: '23502',
  SINTAXIS_INVALIDA: '22P02',
  VALOR_FUERA_DE_RANGO: '22003',
  EXCLUSION_VIOLADA: '23P01',
  DEADLOCK: '40P01',
  FALLA_DE_SERIALIZACION: '40001',
  LOCK_TIMEOUT: '55P03',
  STATEMENT_TIMEOUT: '57014',
} as const;

/**
 * Traduce un error de base de datos a una respuesta HTTP que explique qué pasó.
 *
 * Reemplaza a los `handleDBExceptions` privados que estaban repetidos en seis
 * servicios. Aquellos tenían dos problemas: contemplaban sólo uno o dos códigos
 * —cualquier otro se volvía un 500 sin motivo— y **nunca registraban el error
 * original**, así que el mensaje mandaba a mirar unos logs donde la causa no
 * estaba.
 *
 * Acá el error se registra siempre antes de convertirlo. Si no se lo reconoce,
 * sigue siendo un 500, pero queda el rastro para saber por qué.
 *
 * @param error  lo que vino del driver
 * @param logger el logger del servicio que llama, para que la línea quede a su nombre
 * @param contexto qué se estaba haciendo, para el mensaje
 */
export function traducirErrorDeBase(
  error: unknown,
  logger: Logger,
  contexto?: string,
): never {
  // Una excepción HTTP ya es una decisión tomada: no se la pisa.
  if (error instanceof HttpException) {
    throw error;
  }
  // Un error de dominio (p. ej. una caja inexistente) lo traduce el filtro global.
  if (error instanceof DomainError) {
    throw error;
  }

  const donde = contexto ? ` (${contexto})` : '';
  const e = datosDelError(error);

  switch (e.code) {
    case CODIGOS.UNICO_VIOLADO:
      // El `detail` de Postgres nombra la tabla y la columna: sirve en el log,
      // no en la respuesta.
      // En los legajos el `detail` trae el documento o el CUIL (datos
      // personales): de esos sólo se registra el nombre de la restricción.
      logger.warn(
        `Unicidad violada${donde}: ${
          e.constraint?.startsWith('UQ_employee_')
            ? e.constraint
            : (e.detail ?? e.message)
        }`,
      );
      throw new ConflictException(
        `Ya existe un registro con esos datos${donde}`,
      );

    case CODIGOS.EXCLUSION_VIOLADA:
      // Una regla de exclusión de la base (p. ej. dos licencias del mismo
      // empleado que se pisan) frenó la escritura que el servicio no alcanzó
      // a detectar: dos operaciones la dispararon a la vez.
      logger.warn(`Exclusión violada${donde}: ${e.detail ?? e.message}`);
      throw new ConflictException(
        `El registro choca con otro que ya existe${donde}`,
      );

    case CODIGOS.CLAVE_FORANEA:
      // Pasa al crear algo apuntando a un registro que no existe, o al borrar
      // uno que todavía está en uso.
      logger.warn(`Clave foránea violada${donde}: ${e.detail ?? e.message}`);
      throw new ConflictException(
        `El registro referenciado no existe, o está siendo usado por otros ` +
          `registros y no se puede borrar${donde}`,
      );

    case CODIGOS.NO_NULO:
      logger.warn(`Campo obligatorio vacío${donde}: ${e.column ?? ''}`);
      throw new BadRequestException(
        `Falta un dato obligatorio${e.column ? `: ${e.column}` : donde}`,
      );

    case CODIGOS.SINTAXIS_INVALIDA:
      logger.warn(`Valor con formato inválido${donde}: ${e.message}`);
      throw new BadRequestException(
        `Alguno de los valores enviados tiene un formato inválido${donde}`,
      );

    case CODIGOS.VALOR_FUERA_DE_RANGO:
      logger.warn(`Valor numérico fuera de rango${donde}: ${e.message}`);
      throw new BadRequestException(
        `Alguno de los valores numéricos es demasiado grande${donde}`,
      );

    case CODIGOS.DEADLOCK:
    case CODIGOS.FALLA_DE_SERIALIZACION:
      // `withTransactionRetry` ya reintenta esto automáticamente (3 intentos
      // en total: el primero y 2 reintentos); si llega acá es porque se
      // agotaron. Un 409 explica mejor que un 500: la operación chocó con
      // otra, no está rota.
      logger.warn(`Choque entre transacciones${donde}: ${e.message}`);
      throw new ConflictException(
        `Dos operaciones chocaron al mismo tiempo${donde}. Probá de nuevo.`,
      );

    case CODIGOS.LOCK_TIMEOUT:
    case CODIGOS.STATEMENT_TIMEOUT:
      throw ocupado(e.code, e.message, logger, donde);

    default:
      // Lo que no sabemos traducir sigue siendo un 500, pero deja rastro.
      logger.error(
        `Error de base no contemplado${donde}: ${e.code ?? 'sin código'} — ${e.message}`,
        e.stack,
      );
      throw new InternalServerErrorException(
        'Ocurrió un error inesperado. Si persiste, avisá al soporte.',
      );
  }
}

export const MENSAJE_SISTEMA_OCUPADO =
  'El sistema está ocupado, reintentá en unos segundos';

function ocupado(
  code: string | undefined,
  message: string,
  logger: Logger,
  donde: string,
): ServiceUnavailableException {
  logger.warn(
    `Timeout de base de datos${donde} (${code ?? 'sin código'}): ${message}`,
  );
  return new ServiceUnavailableException(MENSAJE_SISTEMA_OCUPADO);
}

/**
 * `true` si el error es un corte por `lock_timeout` (55P03) o
 * `statement_timeout` (57014): la base está ocupada, no rota.
 */
export function esTimeoutDeBase(error: unknown): boolean {
  const code = codigoSqlDelError(error);
  return code === CODIGOS.LOCK_TIMEOUT || code === CODIGOS.STATEMENT_TIMEOUT;
}

/** SQLSTATE del error, esté en el error o en el `driverError` de TypeORM. */
export function codigoSqlDelError(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const directo: unknown = (error as Record<string, unknown>).code;
  if (typeof directo === 'string') return directo;
  const driver: unknown = (error as Record<string, unknown>).driverError;
  if (typeof driver === 'object' && driver !== null) {
    const c: unknown = (driver as Record<string, unknown>).code;
    if (typeof c === 'string') return c;
  }
  return undefined;
}

/** Campos que trae un error del driver de Postgres (vía TypeORM), si los trae. */
interface DatosDeErrorDeBase {
  code?: string;
  detail?: string;
  column?: string;
  constraint?: string;
  message: string;
  stack?: string;
}

function datosDelError(error: unknown): DatosDeErrorDeBase {
  if (typeof error !== 'object' || error === null) {
    return { message: String(error) };
  }
  const campo = (nombre: string): string | undefined => {
    const valor: unknown = (error as Record<string, unknown>)[nombre];
    return typeof valor === 'string' ? valor : undefined;
  };
  return {
    code: campo('code'),
    detail: campo('detail'),
    column: campo('column'),
    constraint: campo('constraint'),
    message: campo('message') ?? 'error sin mensaje',
    stack: campo('stack'),
  };
}
