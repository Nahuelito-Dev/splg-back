import { applyDecorators, UseInterceptors } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiOkResponse,
  ApiPayloadTooLargeResponse,
  ApiTooManyRequestsResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import { archivoConTope } from '../../../s3/upload-limits';
import { DownloadLinkResponseDto } from '../../../s3/dto/download-link.dto';
import { TOPE_MAXIMO_DEL_CHAT } from '../../domain/adjuntos';
import { CUERPO_DEL_ADJUNTO } from '../dto/chat-attachment.dto';

/** Lo común de toda subida de un adjunto del chat: multer con tope y su documentación. */
export function SubidaDeAdjunto(tipos: string): MethodDecorator {
  return applyDecorators(
    UseInterceptors(archivoConTope(TOPE_MAXIMO_DEL_CHAT, 'archivo')),
    ApiConsumes('multipart/form-data'),
    ApiBody(CUERPO_DEL_ADJUNTO),
    ApiBadRequestResponse({
      description:
        'Falta el archivo o está vacío (`ATTACHMENT_MISSING`); `clientMessageId` que no es uuid; epígrafe de más de 500 caracteres; demasiados campos en el formulario',
    }),
    ApiUnsupportedMediaTypeResponse({
      description: `Tipo no permitido en este chat, mirado por el contenido y no por la extensión (\`ATTACHMENT_TYPE_NOT_ALLOWED\`; acá se aceptan ${tipos}); una foto que no se puede leer (\`ATTACHMENT_UNREADABLE\`)`,
    }),
    ApiPayloadTooLargeResponse({
      description:
        'Supera el tope (`ATTACHMENT_TOO_LARGE`): fotos 5 MB y PDF 10 MB en la bandeja; 10 MB en el soporte; más de 24 megapíxeles',
    }),
    ApiTooManyRequestsResponse({
      description:
        '30 archivos por persona y empresa en el día (`ATTACHMENT_DAILY_LIMIT`); más de 30 mensajes por minuto (`CHAT_RATE_LIMITED`); el cupo de subidas de la sesión',
    }),
  );
}

/** La documentación común de la descarga: la URL firmada y el 409 del escaneo. */
export function LecturaDeAdjunto(): MethodDecorator {
  return applyDecorators(
    ApiOkResponse({
      type: DownloadLinkResponseDto,
      description:
        'URL firmada de S3 (vence a los 300 s, `expiresAt`); fotos y PDF se ven en pantalla, el resto se baja',
    }),
    ApiConflictResponse({
      description:
        'El antivirus todavía lo está revisando (`ATTACHMENT_SCAN_PENDING`), o no lo pudo revisar todavía (`ATTACHMENT_SCAN_FAILED`: se reintenta solo; nadie lo baja mientras tanto)',
    }),
  );
}

/** Texto común de la operación de subida. */
export const DESCRIPCION_DE_LA_SUBIDA =
  'Multipart: `file`, `clientMessageId` y `caption` opcional (≤ 500). Un adjunto por mensaje (`kind = attachment`, el epígrafe en `body`). El tipo se decide por el contenido; las fotos se guardan re-codificadas y sin EXIF (`scanStatus: clean`); PDF y documentos quedan `pending` hasta que los revisa el antivirus (llega `chat:message` con el estado nuevo). Reintentar con el mismo `clientMessageId` devuelve el mensaje ya guardado (200) sin volver a subir. La respuesta trae `attachment` sin URL.';
