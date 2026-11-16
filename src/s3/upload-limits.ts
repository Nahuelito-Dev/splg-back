import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  HttpException,
  mixin,
  NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import { applyDecorators, SetMetadata, UseInterceptors } from '@nestjs/common';
import { ApiUnprocessableEntityResponse } from '@nestjs/swagger';
import {
  IDEMPOTENT_DESPUES_DE_MULTER_KEY,
  IDEMPOTENT_KEY,
} from '../common/decorators/idempotent.decorator';
import { IdempotencyDespuesDeMulterInterceptor } from '../common/interceptors/idempotency.interceptor';
import { FileInterceptor } from '@nestjs/platform-express';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { Observable } from 'rxjs';

/** 5 MB: tope de las fotos de perfil, vehículo, producto, logo e incidencia. */
export const MAX_FOTO_BYTES = 5 * 1024 * 1024;

/** Cuántos campos de texto acompañan al archivo (p. ej. `label`) y su tamaño. */
const MAX_CAMPOS = 5;
const MAX_CAMPO_BYTES = 64 * 1024;

/**
 * Opciones de multer: un solo archivo de hasta `maxBytes`, pocos campos de
 * texto chicos y un tope de partes. Corta en el stream: lo que excede nunca
 * llega a memoria.
 */
export function opcionesDeSubida(maxBytes: number): MulterOptions {
  return {
    limits: {
      fileSize: maxBytes,
      files: 1,
      fields: MAX_CAMPOS,
      fieldSize: MAX_CAMPO_BYTES,
      parts: 1 + MAX_CAMPOS,
    },
  };
}

/** Los errores de multer, en castellano y con el máximo; el resto pasa igual. */
export function traducirErrorDeSubida(
  error: unknown,
  maxBytes: number,
  tipo: 'foto' | 'archivo',
): unknown {
  if (!(error instanceof HttpException)) return error;
  const mensaje = error.message;
  if (
    error instanceof PayloadTooLargeException &&
    mensaje === 'File too large'
  ) {
    const mb = maxBytes / (1024 * 1024);
    return new PayloadTooLargeException(
      `${tipo === 'foto' ? 'La foto' : 'El archivo'} supera el máximo permitido (${mb} MB)`,
    );
  }
  if (
    error instanceof BadRequestException &&
    /^(Too many|Field value too long|Field name too long)/.test(mensaje)
  ) {
    return new BadRequestException(
      'El formulario trae demasiados campos o alguno es demasiado grande',
    );
  }
  return error;
}

/**
 * Interceptor del campo multipart `file` con los topes aplicados en multer.
 * Es la única forma de recibir un archivo: todo endpoint de subida pasa por
 * acá (lo garantiza `upload-limits.spec.ts`).
 */
export function archivoConTope(maxBytes: number, tipo: 'foto' | 'archivo') {
  const Base = FileInterceptor('file', opcionesDeSubida(maxBytes));
  class ArchivoConTope extends Base implements NestInterceptor {
    override async intercept(
      context: ExecutionContext,
      next: CallHandler,
    ): Promise<Observable<unknown>> {
      try {
        return await super.intercept(context, next);
      } catch (error) {
        throw traducirErrorDeSubida(error, maxBytes, tipo);
      }
    }
  }
  return mixin(ArchivoConTope);
}

/**
 * Subida de un archivo idempotente (`Idempotency-Key`): multer primero y la
 * idempotencia después, para que la huella incluya el archivo. Sustituye a
 * `@Idempotent()` + `@UseInterceptors(archivoConTope(...))` en las rutas
 * multipart.
 */
export function ArchivoIdempotente(
  maxBytes: number,
  tipo: 'foto' | 'archivo',
): MethodDecorator {
  return applyDecorators(
    SetMetadata(IDEMPOTENT_KEY, true),
    SetMetadata(IDEMPOTENT_DESPUES_DE_MULTER_KEY, true),
    UseInterceptors(
      archivoConTope(maxBytes, tipo),
      IdempotencyDespuesDeMulterInterceptor,
    ),
    ApiUnprocessableEntityResponse({
      description:
        'La `Idempotency-Key` ya se usó con otro archivo u otros datos.',
    }),
  );
}
