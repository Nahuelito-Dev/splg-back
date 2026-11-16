import { STATUS_CODES } from 'http';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { CODIGOS_DE_ERROR, conCodigo } from '../../common/errors/con-codigo';
import { ADJUNTOS_POR_DIA } from '../domain/adjuntos';

/** Rechazos de la subida de un adjunto del chat (CH7), con su `code`. */

export function faltaElArchivo(): BadRequestException {
  return conCodigo(
    BadRequestException,
    400,
    'Falta el archivo',
    CODIGOS_DE_ERROR.ATTACHMENT_MISSING,
  );
}

export function archivoVacio(): BadRequestException {
  return conCodigo(
    BadRequestException,
    400,
    'El archivo está vacío',
    CODIGOS_DE_ERROR.ATTACHMENT_MISSING,
  );
}

export function tipoNoPermitido(
  tiposEnTexto: string,
): UnsupportedMediaTypeException {
  return conCodigo(
    UnsupportedMediaTypeException,
    415,
    `En este chat se pueden mandar ${tiposEnTexto}.`,
    CODIGOS_DE_ERROR.ATTACHMENT_TYPE_NOT_ALLOWED,
  );
}

export function demasiadoGrande(
  medio: 'photo' | 'file',
  topeBytes: number,
): PayloadTooLargeException {
  const mb = topeBytes / (1024 * 1024);
  return conCodigo(
    PayloadTooLargeException,
    413,
    `${medio === 'photo' ? 'La foto' : 'El archivo'} supera el máximo permitido (${mb} MB)`,
    CODIGOS_DE_ERROR.ATTACHMENT_TOO_LARGE,
  );
}

export function topeDelDia(): HttpException {
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      message: `Ya mandaste ${ADJUNTOS_POR_DIA} archivos hoy. Vas a poder mandar más mañana.`,
      error: STATUS_CODES[HttpStatus.TOO_MANY_REQUESTS],
      code: CODIGOS_DE_ERROR.ATTACHMENT_DAILY_LIMIT,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/**
 * La limpieza de la foto (`sharp`) rechaza con 415 la que no se puede leer y
 * con 413 la de demasiados megapíxeles: el mismo texto, con su `code`.
 */
export function conCodigoDeLaFoto(error: unknown): unknown {
  if (error instanceof UnsupportedMediaTypeException) {
    return conCodigo(
      UnsupportedMediaTypeException,
      415,
      error.message,
      CODIGOS_DE_ERROR.ATTACHMENT_UNREADABLE,
    );
  }
  if (error instanceof PayloadTooLargeException) {
    return conCodigo(
      PayloadTooLargeException,
      413,
      error.message,
      CODIGOS_DE_ERROR.ATTACHMENT_TOO_LARGE,
    );
  }
  return error;
}
