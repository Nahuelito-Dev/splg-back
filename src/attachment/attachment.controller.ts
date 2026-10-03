import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import { AttachmentService } from './attachment.service';
import { AttachmentMapper } from './attachment.mapper';
import { AttachmentOwnerType } from './entities/attachment.entity';
import { AttachmentResponseDto } from './dto/attachment-response.dto';
import { UploadAttachmentDto } from './dto/upload-attachment.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { servirArchivo } from '../common/http/servir-archivo';
import {
  DownloadLinkResponseDto,
  DownloadMode,
  DownloadQueryDto,
} from '../storage/dto/download-link.dto';
import { aEnlaceDeDescarga } from '../storage/download-link';
import { MAX_ATTACHMENT_SIZE_BYTES } from '../common/utils/attachment-rules';

const OWNER_TYPE_PARAM = {
  name: 'ownerType',
  enum: AttachmentOwnerType,
  enumName: 'AttachmentOwnerType',
} as const;

/**
 * Adjuntos genéricos de los módulos de empresa (legajos, combustible, multas,
 * siniestros, remitos, rendiciones). El chofer sólo accede a los de sus propias
 * cargas, siniestros y rendiciones: lo decide `AttachmentService`.
 */
@ApiTags('Attachments')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY)
@Controller('attachments')
export class AttachmentController {
  constructor(private readonly attachmentsService: AttachmentService) {}

  @Post(':ownerType/:ownerId')
  @ApiOperation({
    summary: 'Subir un adjunto a un dueño (PDF, JPG, PNG, WEBP)',
  })
  @ApiParam(OWNER_TYPE_PARAM)
  @ApiParam({ name: 'ownerId', description: 'UUID del dueño' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        label: { type: 'string', maxLength: 80 },
      },
      required: ['file'],
    },
  })
  @ApiCreatedResponse({ type: AttachmentResponseDto })
  @ApiNotFoundResponse({
    description: 'El dueño no existe o es de otra distribuidora',
  })
  @ApiBadRequestResponse({
    description:
      'Falta el archivo o el tipo de dueño todavía no admite adjuntos',
  })
  @ApiForbiddenResponse({
    description: 'Un chofer no puede adjuntar a ese tipo de dueño',
  })
  @ApiUnsupportedMediaTypeResponse({
    description: 'Tipo de archivo no permitido (sólo PDF, JPG, PNG, WEBP)',
  })
  @ApiPayloadTooLargeResponse({
    description: 'El archivo supera el máximo permitido',
  })
  @UseInterceptors(
    FileInterceptor('file', {
      // Techo técnico por arriba del límite de negocio (el 413 documentado lo
      // da AttachmentService): sólo una salvaguarda contra abuso.
      limits: { fileSize: MAX_ATTACHMENT_SIZE_BYTES * 2 },
    }),
  )
  async upload(
    @Param('ownerType', new ParseEnumPipe(AttachmentOwnerType))
    ownerType: AttachmentOwnerType,
    @Param('ownerId', ParseUUIDPipe) ownerId: string,
    @Body() dto: UploadAttachmentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AttachmentResponseDto> {
    return AttachmentMapper.toDto(
      await this.attachmentsService.upload(
        ownerType,
        ownerId,
        distributorId,
        file,
        dto.label,
        { userId: user.user_id, role: user.role },
      ),
    );
  }

  // Va antes que `:ownerType/:ownerId` para que ".../download" no se lea como un ownerId.
  @Get(':attachmentId/download')
  @ApiOperation({
    summary: 'Descargar un adjunto',
    description:
      'Por defecto devuelve el archivo: redirige (302) a una URL firmada con ' +
      'S3, o lo sirve por streaming con el driver local. Con `?modo=url` ' +
      'devuelve `{ url, expiresAt }` en JSON, sin redirect: es lo que tiene ' +
      'que usar el panel (un 302 cross-origin pierde el token y choca con CORS).',
  })
  @ApiParam({ name: 'attachmentId', description: 'Attachment UUID' })
  @ApiOkResponse({
    description:
      'El archivo con su content-type original; con `?modo=url`, el enlace',
    type: DownloadLinkResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Adjunto no encontrado' })
  async download(
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Query() query: DownloadQueryDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const actor = { userId: user.user_id, role: user.role };

    if (query.modo === DownloadMode.URL) {
      const signed = await this.attachmentsService.getSignedDownload(
        attachmentId,
        distributorId,
        actor,
      );
      res.json(aEnlaceDeDescarga(signed, req.originalUrl.split('?')[0]));
      return;
    }

    const download = await this.attachmentsService.getDownload(
      attachmentId,
      distributorId,
      actor,
    );

    if (download.kind === 'redirect') {
      res.redirect(HttpStatus.FOUND, download.url);
      return;
    }

    servirArchivo(res, download);
  }

  @Get(':ownerType/:ownerId')
  @ApiOperation({ summary: 'Listar los adjuntos de un dueño' })
  @ApiParam(OWNER_TYPE_PARAM)
  @ApiParam({ name: 'ownerId', description: 'UUID del dueño' })
  @ApiOkResponse({ type: AttachmentResponseDto, isArray: true })
  @ApiNotFoundResponse({
    description: 'El dueño no existe o es de otra distribuidora',
  })
  @ApiBadRequestResponse({
    description: 'El tipo de dueño todavía no admite adjuntos',
  })
  @ApiForbiddenResponse({
    description: 'Un chofer no puede acceder a ese tipo de dueño',
  })
  async list(
    @Param('ownerType', new ParseEnumPipe(AttachmentOwnerType))
    ownerType: AttachmentOwnerType,
    @Param('ownerId', ParseUUIDPipe) ownerId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AttachmentResponseDto[]> {
    const attachments = await this.attachmentsService.list(
      ownerType,
      ownerId,
      distributorId,
      { userId: user.user_id, role: user.role },
    );
    return attachments.map((a) => AttachmentMapper.toDto(a));
  }

  @Delete(':attachmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Borrar un adjunto' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment UUID' })
  @ApiNoContentResponse({ description: 'Borrado' })
  @ApiNotFoundResponse({ description: 'Adjunto no encontrado' })
  async remove(
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.attachmentsService.remove(attachmentId, distributorId, {
      userId: user.user_id,
      role: user.role,
    });
  }
}
