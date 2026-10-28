import {
  BadRequestException,
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
  Res,
  UploadedFile,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBadRequestResponse,
  ApiFoundResponse,
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
import {
  AttachmentService,
  mensajeSoloPorSuEndpoint,
  OWNER_TYPES_SOLO_POR_SU_ENDPOINT,
} from './attachment.service';
import { AttachmentMapper } from './attachment.mapper';
import { AttachmentOwnerType } from './entities/attachment.entity';
import { AttachmentResponseDto } from './dto/attachment-response.dto';
import { UploadAttachmentDto } from './dto/upload-attachment.dto';
import { Auth } from '../common/decorators/auth.decorator';
import { RoleType } from '../common/constants/role-type.enum';
import { CurrentDistributor } from '../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import {
  DownloadLinkResponseDto,
  DownloadMode,
  DownloadAttachmentQueryDto,
} from '../s3/dto/download-link.dto';
import { aEnlaceDeDescarga } from '../s3/download-link';
import { ArchivoIdempotente } from '../s3/upload-limits';
import { MAX_ATTACHMENT_SIZE_BYTES } from '../common/utils/attachment-rules';

const OWNER_TYPE_PARAM = {
  name: 'ownerType',
  enum: AttachmentOwnerType,
  enumName: 'AttachmentOwnerType',
} as const;

/**
 * Adjuntos genéricos de los módulos de empresa (legajos, combustible, multas,
 * siniestros, remitos, rendiciones, movimientos de caja, cuentas corrientes y
 * pedidos). El chofer sólo accede a los de sus propias
 * cargas, siniestros y rendiciones: lo decide `AttachmentService`.
 */
@ApiTags('Attachments')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN, RoleType.DELIVERY)
@Controller('attachments')
export class AttachmentController {
  constructor(private readonly attachmentsService: AttachmentService) {}

  @Post(':ownerType/:ownerId')
  @ApiOperation({
    summary:
      'Subir un adjunto a un dueño (PDF, JPG, PNG, WEBP, Word .docx, Excel .xlsx, CSV)',
    description:
      'Admin y super admin: PDF, JPG, PNG, WEBP, Word (.docx), Excel (.xlsx) y CSV (UTF-8 o Windows-1252; también se acepta `application/vnd.ms-excel` si el archivo se llama `.csv`), hasta 10 MB. Se valida el contenido por su estructura, no sólo el tipo declarado: un docx/xlsx con macros, ejecutables u objetos incrustados se rechaza. Chofer: sólo PDF y imágenes. Word, Excel y CSV se entregan siempre como descarga. Dueños (`ownerType`): employee, fuel_load, traffic_fine, vehicle_accident, purchase_receipt, stock_adjustment, driver_settlement, cash_movement, customer_account_entry, order, insurance_policy e insurance_installment. Los de `insurance_installment` (comprobante de una cuota de seguro) no se suben ni se dan de baja por acá: entran sólo por `POST /api/v2/insurance-installments/:id/receipt`.',
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
    description:
      'Tipo no permitido, contenido que no coincide con el tipo declarado, o (chofer) algo que no es PDF ni imagen',
  })
  @ApiPayloadTooLargeResponse({
    description: 'El archivo supera el máximo permitido',
  })
  @ArchivoIdempotente(MAX_ATTACHMENT_SIZE_BYTES, 'archivo')
  async upload(
    @Param('ownerType', new ParseEnumPipe(AttachmentOwnerType))
    ownerType: AttachmentOwnerType,
    @Param('ownerId', ParseUUIDPipe) ownerId: string,
    @Body() dto: UploadAttachmentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AttachmentResponseDto> {
    if (OWNER_TYPES_SOLO_POR_SU_ENDPOINT.includes(ownerType)) {
      throw new BadRequestException(mensajeSoloPorSuEndpoint(ownerType));
    }
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
      'Por defecto devuelve el archivo: redirige (302) a una URL firmada de ' +
      'S3. Con `?disposicion=inline` el navegador lo muestra en vez de bajarlo ' +
      '(sólo PDF e imágenes; HTML, SVG y demás se entregan siempre como descarga). Con `?modo=url` ' +
      'devuelve `{ url, expiresAt, requiresAuth }` en JSON, sin redirect: es lo que tiene ' +
      'que usar el panel (un 302 cross-origin pierde el token y choca con CORS).',
  })
  @ApiParam({ name: 'attachmentId', description: 'Attachment UUID' })
  @ApiOkResponse({
    description:
      'Con `?modo=url`: el enlace `{ url, expiresAt, requiresAuth }`',
    type: DownloadLinkResponseDto,
  })
  @ApiFoundResponse({
    description:
      'Sin `modo`: redirección (302) a la URL firmada de S3, que sirve el archivo con su content-type original',
  })
  @ApiNotFoundResponse({ description: 'Adjunto no encontrado' })
  async download(
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Query() query: DownloadAttachmentQueryDto,
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ): Promise<void> {
    const actor = { userId: user.user_id, role: user.role };

    if (query.modo === DownloadMode.URL) {
      const signed = await this.attachmentsService.getSignedDownload(
        attachmentId,
        distributorId,
        actor,
        query.disposicion,
      );
      res.json(aEnlaceDeDescarga(signed));
      return;
    }

    const url = await this.attachmentsService.getDownload(
      attachmentId,
      distributorId,
      actor,
      query.disposicion,
    );
    res.redirect(HttpStatus.FOUND, url);
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
  @ApiBadRequestResponse({
    description:
      'Es el comprobante de una cuota de seguro: no se da de baja por acá',
  })
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
