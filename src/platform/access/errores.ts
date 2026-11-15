import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CODIGOS_DE_ERROR, conCodigo } from '../../common/errors/con-codigo';

export const MENSAJE_MODULO_DESHABILITADO =
  'Esta función no está disponible para la distribuidora';

/** 403 de un endpoint o proceso de un módulo que la empresa no tiene habilitado. */
export function moduloDeshabilitado(): ForbiddenException {
  return conCodigo(
    ForbiddenException,
    403,
    MENSAJE_MODULO_DESHABILITADO,
    CODIGOS_DE_ERROR.MODULE_DISABLED,
  );
}

/** 400 de una clave de módulo que no está en el catálogo. */
export function moduloDesconocido(): BadRequestException {
  return conCodigo(
    BadRequestException,
    400,
    'El módulo indicado no existe',
    CODIGOS_DE_ERROR.MODULE_UNKNOWN,
  );
}
