import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiFoundResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import { AttachmentResponseDto } from '../attachment/dto/attachment-response.dto';
import {
  DownloadAttachmentQueryDto,
  DownloadLinkResponseDto,
  DownloadMode,
} from '../s3/dto/download-link.dto';
import { aEnlaceDeDescarga } from '../s3/download-link';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { Permiso } from '../common/decorators/permiso.decorator';
import { MAX_ATTACHMENT_SIZE_BYTES } from '../common/utils/attachment-rules';
import { ArchivoIdempotente } from '../s3/upload-limits';
import {
  TipoDeDocumentoDeVehiculo,
  UploadedCarDocumentDto,
  UploadedPatentPhotoDto,
  UploadCarDocumentDto,
} from './dto/car-document.dto';
import { CarDocumentsService } from './car-documents.service';

/** Cargas de documentos de vehículo que se escanean al subirlas (F13, API v2). */
@ApiTags('Fleet · Vehicle documents (v2)')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller({ path: 'cars/:carId/documents', version: '2' })
export class CarDocumentsV2Controller {
  constructor(private readonly documents: CarDocumentsService) {}

  @Permiso('flota.ver')
  @Get()
  @ApiOperation({
    summary: 'Listar los documentos y las fotos de patente del vehículo',
    description:
      'Los adjuntos subidos por `POST /v2/cars/:carId/documents` y `.../patent-photo`, los más nuevos primero. La foto de la patente se distingue por `label = "Foto de patente"`. No confundir con `GET /v1/cars/:carId/documents` (estado de la documentación: seguro, VTV, services). Los adjuntos dados de baja no aparecen.',
  })
  @ApiParam({ name: 'carId', description: 'Car UUID' })
  @ApiOkResponse({ type: AttachmentResponseDto, isArray: true })
  @ApiBadRequestResponse({
    description:
      'Id mal formado, o el super admin no eligió distribuidora (`X-Distributor`)',
  })
  @ApiNotFoundResponse({
    description: 'Vehículo no encontrado o de otra distribuidora',
  })
  list(
    @Param('carId', ParseUUIDPipe) carId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AttachmentResponseDto[]> {
    return this.documents.list(carId, distributorId, {
      userId: user.user_id,
      role: user.role,
    });
  }

  @Permiso('flota.ver')
  @Get(':attachmentId/download')
  @ApiOperation({
    summary: 'Bajar un documento o una foto de patente del vehículo',
    description:
      'Con `?modo=url` devuelve `{ url, expiresAt, requiresAuth }` en JSON (URL firmada de S3, sin redirect): es lo que usa el panel. Sin `modo` redirige (302) a la URL firmada. `?disposicion=inline` lo muestra en el navegador en vez de bajarlo.',
  })
  @ApiParam({ name: 'carId', description: 'Car UUID' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment UUID' })
  @ApiOkResponse({
    description:
      'Con `?modo=url`: el enlace `{ url, expiresAt, requiresAuth }`',
    type: DownloadLinkResponseDto,
  })
  @ApiFoundResponse({
    description: 'Sin `modo`: redirección (302) a la URL firmada de S3',
  })
  @ApiBadRequestResponse({
    description:
      'Id mal formado, `modo` o `disposicion` inválidos, o el super admin no eligió distribuidora (`X-Distributor`)',
  })
  @ApiNotFoundResponse({
    description:
      'Vehículo no encontrado o de otra distribuidora, o el adjunto no existe, no es de ese vehículo o está dado de baja',
  })
  async download(
    @Param('carId', ParseUUIDPipe) carId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Query() query: DownloadAttachmentQueryDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ): Promise<void> {
    const actor = { userId: user.user_id, role: user.role };
    if (query.modo === DownloadMode.URL) {
      res.json(
        aEnlaceDeDescarga(
          await this.documents.downloadLink(
            carId,
            attachmentId,
            distributorId,
            actor,
            query.disposicion,
          ),
        ),
      );
      return;
    }
    res.redirect(
      HttpStatus.FOUND,
      await this.documents.downloadUrl(
        carId,
        attachmentId,
        distributorId,
        actor,
        query.disposicion,
      ),
    );
  }

  @Permiso('flota.gestionar')
  @Delete(':attachmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Dar de baja un documento o una foto de patente del vehículo',
    description:
      'Baja lógica: el adjunto deja de listarse y de poder bajarse; el archivo queda guardado como respaldo. La lectura del escaneo no se borra.',
  })
  @ApiParam({ name: 'carId', description: 'Car UUID' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment UUID' })
  @ApiNoContentResponse({ description: 'Dado de baja' })
  @ApiBadRequestResponse({
    description:
      'Id mal formado, o el super admin no eligió distribuidora (`X-Distributor`)',
  })
  @ApiNotFoundResponse({
    description:
      'Vehículo no encontrado o de otra distribuidora, o el adjunto no existe, no es de ese vehículo o ya estaba dado de baja',
  })
  async remove(
    @Param('carId', ParseUUIDPipe) carId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.documents.remove(carId, attachmentId, distributorId, {
      userId: user.user_id,
      role: user.role,
    });
  }

  @Permiso('flota.gestionar')
  @Post()
  @ApiOperation({
    summary: 'Subir y escanear un documento del vehículo',
    description:
      'Multipart con `file` (PDF, JPG, PNG o WEBP, hasta 10 MB) y `documentType`. El archivo queda protegido (se baja con URL firmada) y se escanea en el mismo pedido: `scan.data` trae el vencimiento, la emisión, la aseguradora, la póliza y la patente leídos para precargar el formulario, y la lectura queda guardada. `scan.available` es `false` si no hay lector configurado; `scan.data` es `null` (con `scan.warning`) si la lectura falló o tardó más de 30 s: en todos los casos la subida vale y los datos se cargan a mano. Idempotente vía `Idempotency-Key`.',
  })
  @ApiParam({ name: 'carId', description: 'Car UUID' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'documentType'],
      properties: {
        file: { type: 'string', format: 'binary' },
        documentType: { enum: Object.values(TipoDeDocumentoDeVehiculo) },
      },
    },
  })
  @ApiCreatedResponse({ type: UploadedCarDocumentDto })
  @ApiBadRequestResponse({
    description:
      'Id mal formado, falta el tipo de documento o no es válido, falta el archivo o está vacío, o el super admin no eligió distribuidora (`X-Distributor`)',
  })
  @ApiNotFoundResponse({
    description: 'Vehículo no encontrado o de otra distribuidora',
  })
  @ApiUnsupportedMediaTypeResponse({
    description:
      'No es un PDF ni una imagen (JPG, PNG, WEBP), o el contenido no coincide con el tipo declarado',
  })
  @ApiPayloadTooLargeResponse({
    description: 'El archivo supera el máximo permitido (10 MB)',
  })
  @ArchivoIdempotente(MAX_ATTACHMENT_SIZE_BYTES, 'archivo')
  uploadDocument(
    @Param('carId', ParseUUIDPipe) carId: string,
    @Body() dto: UploadCarDocumentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UploadedCarDocumentDto> {
    return this.documents.uploadDocument(
      carId,
      dto.documentType,
      file,
      distributorId,
      { userId: user.user_id, role: user.role },
    );
  }

  @Permiso('flota.gestionar')
  @Post('patent-photo')
  @ApiOperation({
    summary: 'Subir y leer la foto de la patente',
    description:
      'Multipart con `file` (JPG, PNG o WEBP, hasta 10 MB). La foto se protege como un adjunto separado. Si la patente leída, normalizada sin espacios ni guiones, no coincide con la del vehículo, devuelve `mismatch: true` con `warning` y deja un aviso en la bandeja del administrador. Sin lector, o si no se pudo leer, `mismatch` es `false` y `readPatent` es `null`. Idempotente vía `Idempotency-Key`.',
  })
  @ApiParam({ name: 'carId', description: 'Car UUID' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiCreatedResponse({ type: UploadedPatentPhotoDto })
  @ApiBadRequestResponse({
    description:
      'Id mal formado, falta el archivo o está vacío, o el super admin no eligió distribuidora (`X-Distributor`)',
  })
  @ApiNotFoundResponse({
    description: 'Vehículo no encontrado o de otra distribuidora',
  })
  @ApiUnsupportedMediaTypeResponse({
    description:
      'No es una imagen JPG, PNG o WEBP, o el contenido no coincide con el tipo declarado',
  })
  @ApiPayloadTooLargeResponse({
    description: 'El archivo supera el máximo permitido (10 MB)',
  })
  @ArchivoIdempotente(MAX_ATTACHMENT_SIZE_BYTES, 'archivo')
  uploadPatentPhoto(
    @Param('carId', ParseUUIDPipe) carId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UploadedPatentPhotoDto> {
    return this.documents.uploadPatentPhoto(carId, file, distributorId, {
      userId: user.user_id,
      role: user.role,
    });
  }
}
