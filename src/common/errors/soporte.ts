import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CODIGOS_DE_ERROR, conCodigo } from './con-codigo';

/**
 * Los rechazos del modo soporte del administrador general (ver
 * `splg-docs/sistema/back/MODO-SOPORTE.md`). Viven acá porque los lanzan
 * piezas de varios módulos: el `AuthGuard`, el `AlcanceGuard`, la capa de base
 * (`ActorEnLaBase`) y el filtro global.
 */
export const MENSAJE_SOPORTE_REQUERIDO =
  'Para ver datos de una empresa entrá en modo soporte';
export const MENSAJE_SOPORTE_SOLO_LECTURA =
  'Estás en modo soporte: es sólo lectura';
export const MENSAJE_SOPORTE_TERMINADO =
  'La sesión de soporte ya no está activa: volvé a pedir acceso';
export const MENSAJE_SOPORTE_INEXISTENTE = 'No existe esa sesión de soporte';

/** 403: el administrador general pidió algo de una empresa sin sesión de soporte. */
export function soporteRequerido(): ForbiddenException {
  return conCodigo(
    ForbiddenException,
    403,
    MENSAJE_SOPORTE_REQUERIDO,
    CODIGOS_DE_ERROR.SUPPORT_SESSION_REQUIRED,
  );
}

/** 403: una escritura en modo soporte (lo frena el guard o la base). */
export function soloLecturaDeSoporte(): ForbiddenException {
  return conCodigo(
    ForbiddenException,
    403,
    MENSAJE_SOPORTE_SOLO_LECTURA,
    CODIGOS_DE_ERROR.SUPPORT_READ_ONLY,
  );
}

/**
 * 403 (no 401: un 401 cierra la sesión del panel): la sesión pedida está
 * pendiente, vencida, finalizada o revocada.
 */
export function soporteTerminado(): ForbiddenException {
  return conCodigo(
    ForbiddenException,
    403,
    MENSAJE_SOPORTE_TERMINADO,
    CODIGOS_DE_ERROR.SUPPORT_SESSION_ENDED,
  );
}

/** 404: la sesión no existe o es de otro administrador general. */
export function soporteInexistente(): NotFoundException {
  return conCodigo(
    NotFoundException,
    404,
    MENSAJE_SOPORTE_INEXISTENTE,
    CODIGOS_DE_ERROR.SUPPORT_SESSION_NOT_FOUND,
  );
}

const NOMBRE_DEL_ALCANCE: Record<string, string> = {
  personal_data: 'Datos personales',
  files: 'Archivos',
  exports: 'Exportes',
};

/** 403: en modo soporte, algo que pide un alcance que la empresa no aprobó. */
export function soporteSinAlcance(alcance: string): ForbiddenException {
  return conCodigo(
    ForbiddenException,
    403,
    `En modo soporte esto pide el alcance «${NOMBRE_DEL_ALCANCE[alcance] ?? alcance}», y la sesión no lo tiene`,
    CODIGOS_DE_ERROR.SUPPORT_SCOPE_REQUIRED,
  );
}

/** Si el error es un rechazo del modo soporte (un 403 con `code` SUPPORT_*). */
export function esRechazoDeSoporte(error: unknown): boolean {
  if (!(error instanceof ForbiddenException)) return false;
  const r = error.getResponse();
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof (r as { code?: unknown }).code === 'string' &&
    (r as { code: string }).code.startsWith('SUPPORT_')
  );
}
