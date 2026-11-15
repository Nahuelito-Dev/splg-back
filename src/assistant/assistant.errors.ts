import { ConflictException, NotFoundException } from '@nestjs/common';
import { CODIGOS_DE_ERROR, conCodigo } from '../common/errors/con-codigo';

/**
 * Tope de preguntas por base (de cada distribuidora y de la plataforma) y
 * del catálogo de preguntas de ejemplo.
 */
export const TOPE_DE_PREGUNTAS = 200;

/** 404: no existe, está dada de baja o es de otra base (no se revela cuál). */
export function preguntaInexistente(): NotFoundException {
  return conCodigo(
    NotFoundException,
    404,
    'No existe esa pregunta frecuente',
    CODIGOS_DE_ERROR.ASSISTANT_FAQ_NOT_FOUND,
  );
}

export function preguntaRepetida(): ConflictException {
  return conCodigo(
    ConflictException,
    409,
    'Ya hay una pregunta frecuente igual en la base',
    CODIGOS_DE_ERROR.ASSISTANT_FAQ_DUPLICATE,
  );
}

export function claveOcupada(): ConflictException {
  return conCodigo(
    ConflictException,
    409,
    'Ya hay una pregunta frecuente con esa clave',
    CODIGOS_DE_ERROR.ASSISTANT_FAQ_KEY_TAKEN,
  );
}

export function topeAlcanzado(faltan?: number): ConflictException {
  const detalle =
    faltan === undefined
      ? `La base ya tiene ${TOPE_DE_PREGUNTAS} preguntas frecuentes, el máximo: da de baja alguna antes de agregar otra`
      : `Copiar las preguntas de ejemplo superaría el máximo de ${TOPE_DE_PREGUNTAS} preguntas frecuentes: da de baja al menos ${faltan} antes de copiarlas`;
  return conCodigo(
    ConflictException,
    409,
    detalle,
    CODIGOS_DE_ERROR.ASSISTANT_FAQ_LIMIT_REACHED,
  );
}

/** 404 del catálogo: no existe o está dada de baja. */
export function ejemploInexistente(): NotFoundException {
  return conCodigo(
    NotFoundException,
    404,
    'No existe esa pregunta de ejemplo',
    CODIGOS_DE_ERROR.ASSISTANT_TEMPLATE_NOT_FOUND,
  );
}

export function ejemploRepetido(): ConflictException {
  return conCodigo(
    ConflictException,
    409,
    'Ya hay una pregunta de ejemplo igual en el catálogo',
    CODIGOS_DE_ERROR.ASSISTANT_TEMPLATE_DUPLICATE,
  );
}

export function claveDeEjemploOcupada(): ConflictException {
  return conCodigo(
    ConflictException,
    409,
    'Ya hay una pregunta de ejemplo con esa clave',
    CODIGOS_DE_ERROR.ASSISTANT_TEMPLATE_KEY_TAKEN,
  );
}

export function topeDelCatalogo(): ConflictException {
  return conCodigo(
    ConflictException,
    409,
    `El catálogo ya tiene ${TOPE_DE_PREGUNTAS} preguntas de ejemplo, el máximo: da de baja alguna antes de agregar otra`,
    CODIGOS_DE_ERROR.ASSISTANT_TEMPLATE_LIMIT_REACHED,
  );
}

/** Nombre de la restricción que violó un error de Postgres (directo o envuelto por TypeORM). */
function restriccionDelError(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const directo: unknown = (error as Record<string, unknown>).constraint;
  if (typeof directo === 'string') return directo;
  const driver: unknown = (error as Record<string, unknown>).driverError;
  if (typeof driver !== 'object' || driver === null) return undefined;
  const envuelto: unknown = (driver as Record<string, unknown>).constraint;
  return typeof envuelto === 'string' ? envuelto : undefined;
}

/**
 * Traduce los únicos parciales de la base, con su `code`, si algo se escapa
 * del control del servicio (que ya corre con la base bloqueada). `null` si el
 * error es otro.
 */
export function conflictoDeLaBase(error: unknown): ConflictException | null {
  const restriccion = restriccionDelError(error);
  if (restriccion === 'UQ_assistant_faq_pregunta_vigente') {
    return preguntaRepetida();
  }
  if (restriccion === 'UQ_assistant_faq_clave_vigente') return claveOcupada();
  return null;
}

/** Lo mismo para los únicos del catálogo de preguntas de ejemplo. */
export function conflictoDelCatalogo(error: unknown): ConflictException | null {
  const restriccion = restriccionDelError(error);
  if (restriccion === 'UQ_assistant_faq_template_pregunta_vigente') {
    return ejemploRepetido();
  }
  if (restriccion === 'UQ_assistant_faq_template_clave_vigente') {
    return claveDeEjemploOcupada();
  }
  return null;
}
