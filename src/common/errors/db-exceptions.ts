import {
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';

/**
 * Códigos de error de Postgres que sabemos traducir.
 * https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const CODIGOS = {
  UNICO_VIOLADO: '23505',
  CLAVE_FORANEA: '23503',
  NO_NULO: '23502',
  SINTAXIS_INVALIDA: '22P02',
  DEADLOCK: '40P01',
  FALLA_DE_SERIALIZACION: '40001',
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
