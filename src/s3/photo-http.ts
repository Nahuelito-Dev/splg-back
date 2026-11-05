import {
  applyDecorators,
  HttpStatus,
  NotFoundException,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { DownloadMode } from './dto/download-link.dto';
import { aEnlaceDeDescarga } from './download-link';
import {
  PhotoCurrentResponseDto,
  PhotoLinkResponseDto,
} from './dto/photo-link.dto';
import { EnlaceDeFoto } from './entity-photo.service';
import { archivoConTope, MAX_FOTO_BYTES } from './upload-limits';

/** Recibe el campo multipart `file`, con el tope de 5 MB aplicado en multer (413). */
export function SubirFotoInterceptor(): MethodDecorator {
  return UseInterceptors(archivoConTope(MAX_FOTO_BYTES, 'foto'));
}

/** Swagger de `PUT .../photo`: multipart, formatos, tope y errores. */
export function ApiSubirFoto(
  resumen: string,
  tipo: new () => object,
  descripcion = '',
  { conNotFound = true }: { conNotFound?: boolean } = {},
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
    ...(conNotFound
      ? [
          ApiNotFoundResponse({
            description: 'No existe o es de otra distribuidora',
          }),
        ]
      : []),
    ApiUnauthorizedResponse({ description: 'Sin token o token inválido' }),
    ApiBadRequestResponse({ description: 'Falta la foto o está vacía' }),
    ApiUnsupportedMediaTypeResponse({
      description: 'No es JPG, PNG ni WEBP (o el contenido no coincide)',
    }),
    ApiPayloadTooLargeResponse({ description: 'La foto supera los 5 MB' }),
  );
}

/** Swagger de `GET .../photo`. */
export function ApiVerFoto(
  resumen: string,
  descripcionDe400 = 'El modo no es válido',
): MethodDecorator {
  return applyDecorators(
    ApiOperation({
      summary: resumen,
      description:
        'Por defecto redirige (302) a la URL firmada de S3. Con `?modo=url` ' +
        'devuelve `{ url, expiresAt, requiresAuth }` en JSON, sin redirect; si ' +
        'no tiene foto, `url: null`.',
    }),
    ApiOkResponse({ type: PhotoLinkResponseDto }),
    ApiUnauthorizedResponse({ description: 'Sin token o token inválido' }),
    ApiBadRequestResponse({ description: descripcionDe400 }),
    ApiNotFoundResponse({
      description:
        'No existe o es de otra distribuidora; sin `modo`, también si no tiene foto',
    }),
  );
}

/**
 * Responde `GET .../photo`: JSON con `?modo=url`, redirect 302 a la URL firmada
 * si no. Sólo se sirven fotos del bucket: nunca una URL de texto.
 */
export function responderFoto(
  res: Response,
  modo: DownloadMode | undefined,
  enlace: EnlaceDeFoto,
): void {
  if (modo === DownloadMode.URL) {
    if (enlace.kind === 'stored') {
      res.json(aEnlaceDeDescarga(enlace.signed));
      return;
    }
    const dto = new PhotoLinkResponseDto();
    dto.url = null;
    dto.expiresAt = null;
    dto.requiresAuth = false;
    res.json(dto);
    return;
  }
  if (enlace.kind === 'none') throw new NotFoundException('No tiene foto');
  res.redirect(HttpStatus.FOUND, enlace.signed.url);
}

/** La foto vigente tras un `PUT` o `DELETE` (API v2): `{ url, expiresAt }`, con `null` si no hay. */
export function aFotoVigente(enlace: EnlaceDeFoto): PhotoCurrentResponseDto {
  const dto = new PhotoCurrentResponseDto();
  dto.url = enlace.kind === 'stored' ? enlace.signed.url : null;
  dto.expiresAt = enlace.kind === 'stored' ? enlace.signed.expiresAt : null;
  return dto;
}
