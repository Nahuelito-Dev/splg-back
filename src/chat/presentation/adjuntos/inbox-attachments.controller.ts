import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { RoleType } from '../../../common/constants/role-type.enum';
import { Auth } from '../../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../../common/decorators/current-distributor.decorator';
import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../../common/decorators/current-user.decorator';
import { Permiso } from '../../../common/decorators/permiso.decorator';
import { RequiereModulo } from '../../../platform/access/requiere-modulo.decorator';
import type { DownloadLinkResponseDto } from '../../../s3/dto/download-link.dto';
import { BandejaAcceso, lectorDe } from '../../application/bandeja-acceso';
import { BandejaAdjuntos } from '../../application/bandeja-adjuntos.service';
import { BandejaPresenter } from '../bandeja.presenter';
import { InboxMessageDto } from '../dto/bandeja-response.dto';
import { SendAttachmentDto } from '../dto/chat-attachment.dto';
import {
  DESCRIPCION_DE_LA_SUBIDA,
  LecturaDeAdjunto,
  SubidaDeAdjunto,
} from './adjuntos.docs';

const NO_EXISTE =
  'La conversación o el mensaje no existen, son de otra empresa o de un canal que quien pide no atiende; el mensaje no tiene adjunto, se redactó o su archivo se bloqueó por virus';
const SIN_CANAL =
  'El rol no atiende ningún canal de mensajes (`PERMISSION_DENIED`) o la empresa no tiene habilitados los mensajes (`MODULE_DISABLED`)';

/**
 * Adjuntos de la bandeja de la empresa (C3 y C2, CH7): fotos y PDF. Mismo
 * aislamiento que los mensajes: otra empresa u otro canal → 404.
 */
@ApiTags('Inbox (company)')
@RequiereModulo('chat')
@Permiso('mensajes.clientes', 'mensajes.choferes')
@Auth(RoleType.ADMIN)
@Controller({ path: 'conversations', version: '2' })
export class InboxAttachmentsController {
  constructor(
    private readonly acceso: BandejaAcceso,
    private readonly adjuntos: BandejaAdjuntos,
    private readonly presentar: BandejaPresenter,
  ) {}

  @Post(':id/attachments')
  @ApiOperation({
    summary: 'Mandar una foto o un PDF',
    description: `${DESCRIPCION_DE_LA_SUBIDA} Cuenta como respuesta de la empresa.`,
  })
  @SubidaDeAdjunto('PDF, JPG, PNG o WEBP')
  @ApiCreatedResponse({ type: InboxMessageDto })
  @ApiOkResponse({ type: InboxMessageDto, description: 'Reintento: ya estaba' })
  @ApiForbiddenResponse({ description: SIN_CANAL })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  @ApiConflictResponse({
    description:
      'La conversación está cerrada (`CONVERSATION_CLOSED`) o la persona ya no es de la empresa (`CHAT_NOT_WRITABLE`)',
  })
  async subir(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendAttachmentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InboxMessageDto> {
    const actor = await this.acceso.delPersonal(user, distributorId);
    const r = await this.adjuntos.enviar(actor, id, file, dto);
    res.status(r.created ? HttpStatus.CREATED : HttpStatus.OK);
    return this.presentar.mensaje(r.message, lectorDe(actor));
  }

  @Get(':id/messages/:messageId/attachment')
  @ApiOperation({
    summary: 'URL para ver o bajar el adjunto de un mensaje',
    description:
      'URL firmada de corta vida (la del mensaje no viaja en el listado).',
  })
  @LecturaDeAdjunto()
  @ApiForbiddenResponse({ description: SIN_CANAL })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  async enlace(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ): Promise<DownloadLinkResponseDto> {
    const actor = await this.acceso.delPersonal(user, distributorId);
    return this.adjuntos.enlace(actor, id, messageId);
  }
}
