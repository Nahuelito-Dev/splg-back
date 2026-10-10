import {
  applyDecorators,
  HttpStatus,
  NotFoundException,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { DownloadMode } from './dto/download-link.dto';
import { aEnlaceDeDescarga } from './download-link';
import { PhotoLinkResponseDto } from './dto/photo-link.dto';
import { EnlaceDeFoto, MAX_FOTO_BYTES } from './entity-photo.service';

/**
 * Recibe el campo multipart `file`. El tope técnico va por arriba del límite
 * de negocio (el 413 documentado lo da `EntityPhotoService`): sólo frena abusos.
 */
export function SubirFotoInterceptor(): MethodDecorator {
  return UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_FOTO_BYTES * 2 } }),
  );
}

/** Swagger de `PUT .../photo`: multipart, formatos, tope y errores. */
export function ApiSubirFoto(
  resumen: string,
  tipo: new () => object,
  descripcion = '',
): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: resumen,
      description:
        'Multipart, campo `file`: JPG, PNG o WEBP de hasta 5 MB (el tipo se ' +
        'valida por el contenido, no por el header). Si ya tenía foto, la ' +
        'anterior se borra del bucket. ' +
        descripcion,
    }),
    ApiConsumes('multipart/form-data'),
    ApiBody({
      schema: {
        type: 'object',
        properties: { file: { type: 'string', format: 'binary' } },
        required: ['file'],
      },
    }),
    ApiOkResponse({ type: tipo }),
    ApiNotFoundResponse({
      description: 'No existe o es de otra distribuidora',
    }),
    ApiBadRequestResponse({ description: 'Falta la foto o está vacía' }),
    ApiUnsupportedMediaTypeResponse({
      description: 'No es JPG, PNG ni WEBP (o el contenido no coincide)',
    }),
    ApiPayloadTooLargeResponse({ description: 'La foto supera los 5 MB' }),
  );
}

/** Swagger de `GET .../photo`. */
export function ApiVerFoto(resumen: string): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: resumen,
      description:
        'Por defecto redirige (302) a la URL firmada de S3 (una URL externa nunca se redirige: va en JSON). Con `?modo=url` ' +
        'devuelve `{ url, expiresAt, requiresAuth }` en JSON, sin redirect; si ' +
        'no tiene foto, `url: null`.',
    }),
    ApiOkResponse({ type: PhotoLinkResponseDto }),
    ApiNotFoundResponse({
      description:
        'No existe o es de otra distribuidora; sin `modo`, también si no tiene foto',
    }),
  );
}

/**
 * Responde `GET .../photo`: JSON con `?modo=url`, redirect 302 a la URL firmada
 * si no. La URL externa (la eligió quien reportó) nunca se redirige: se
 * devuelve en JSON para que no sirva de open redirect.
 */
export function responderFoto(
  res: Response,
  modo: DownloadMode | undefined,
  enlace: EnlaceDeFoto,
): void {
  if (modo === DownloadMode.URL || enlace.kind === 'external') {
    if (enlace.kind === 'stored') {
      res.json(aEnlaceDeDescarga(enlace.signed));
      return;
    }
    const dto = new PhotoLinkResponseDto();
    dto.url = enlace.kind === 'external' ? enlace.url : null;
    dto.expiresAt = null;
    dto.requiresAuth = false;
    res.json(dto);
    return;
  }
  if (enlace.kind === 'none') throw new NotFoundException('No tiene foto');
  res.redirect(HttpStatus.FOUND, enlace.signed.url);
}
