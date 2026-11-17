import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { CODIGOS_DE_ERROR, conCodigo } from '../common/errors/con-codigo';
import { CODIGO_ID_INVALIDO } from '../common/validation/traducir-excepcion';
import { MINUTOS_ENTRE_CORRIDAS, TOPE_DE_CASOS } from './assistant-lab.dominio';

/** 404: el cliente no existe o no es de la empresa (no se revela cuál). */
export function clienteInexistente(): NotFoundException {
  return conCodigo(
    NotFoundException,
    404,
    'No existe ese cliente entre los de la distribuidora',
    CODIGOS_DE_ERROR.ASSISTANT_PREVIEW_CUSTOMER_NOT_FOUND,
  );
}

/** 404: el grupo no tiene preguntas pendientes en el último año (o ya se resolvió). */
export function grupoInexistente(): NotFoundException {
  return conCodigo(
    NotFoundException,
    404,
    'No hay preguntas sin respuesta pendientes con ese identificador',
    CODIGOS_DE_ERROR.ASSISTANT_UNANSWERED_NOT_FOUND,
  );
}

/** 400: el identificador de un grupo no son 32 hexadecimales. */
export function idDeGrupoInvalido(): BadRequestException {
  return conCodigo(
    BadRequestException,
    400,
    'El identificador no es válido',
    CODIGO_ID_INVALIDO,
  );
}

export function casoInexistente(): NotFoundException {
  return conCodigo(
    NotFoundException,
    404,
    'No existe ese caso de prueba',
    CODIGOS_DE_ERROR.ASSISTANT_REGRESSION_CASE_NOT_FOUND,
  );
}

export function casoRepetido(): ConflictException {
  return conCodigo(
    ConflictException,
    409,
    'Ya hay un caso de prueba con esa misma pregunta',
    CODIGOS_DE_ERROR.ASSISTANT_REGRESSION_CASE_DUPLICATE,
  );
}

export function topeDeCasos(): ConflictException {
  return conCodigo(
    ConflictException,
    409,
    `Ya tenés ${TOPE_DE_CASOS} casos de prueba, el máximo: da de baja alguno antes de agregar otro`,
    CODIGOS_DE_ERROR.ASSISTANT_REGRESSION_CASE_LIMIT_REACHED,
  );
}

export function sinCasos(): ConflictException {
  return conCodigo(
    ConflictException,
    409,
    'No hay casos de prueba para correr: cargá al menos uno',
    CODIGOS_DE_ERROR.ASSISTANT_REGRESSION_NO_CASES,
  );
}

export function corridaEnCurso(): ConflictException {
  return conCodigo(
    ConflictException,
    409,
    'Ya hay una prueba de los casos en curso: esperá a que termine',
    CODIGOS_DE_ERROR.ASSISTANT_REGRESSION_RUN_IN_PROGRESS,
  );
}

export function sinCorridas(): NotFoundException {
  return conCodigo(
    NotFoundException,
    404,
    'Todavía no se probaron los casos',
    CODIGOS_DE_ERROR.ASSISTANT_REGRESSION_RUN_NOT_FOUND,
  );
}

/** 400 de la segunda capa: un caso que la base rechazaría. */
export function casoInvalido(detalle: string): BadRequestException {
  return new BadRequestException(detalle);
}

/** Un 429 con cuerpo propio (`HttpException` pide el estado aparte). */
class DemasiadasPruebas extends HttpException {
  constructor(respuesta: object) {
    super(respuesta, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/** 429: el cupo mensual de pruebas (probador y lote) se terminó. */
export function topeDePruebas(): HttpException {
  return conCodigo(
    DemasiadasPruebas,
    HttpStatus.TOO_MANY_REQUESTS,
    'Se terminó el cupo de pruebas del asistente de este mes (el 10 % del tope mensual)',
    CODIGOS_DE_ERROR.ASSISTANT_TEST_QUOTA_REACHED,
  );
}

/** 429: se corrió el lote hace menos de `MINUTOS_ENTRE_CORRIDAS`. */
export function corridaReciente(minutos: number): HttpException {
  return conCodigo(
    DemasiadasPruebas,
    HttpStatus.TOO_MANY_REQUESTS,
    `Los casos se probaron hace menos de ${MINUTOS_ENTRE_CORRIDAS} minutos: probá de nuevo en ${minutos} ${minutos === 1 ? 'minuto' : 'minutos'}`,
    CODIGOS_DE_ERROR.ASSISTANT_REGRESSION_RUN_COOLDOWN,
  );
}

/** `true` si el error es el del cupo de pruebas. */
export function esTopeDePruebas(error: unknown): boolean {
  if (!(error instanceof HttpException)) return false;
  const cuerpo = error.getResponse() as { code?: unknown };
  return cuerpo.code === CODIGOS_DE_ERROR.ASSISTANT_TEST_QUOTA_REACHED;
}
