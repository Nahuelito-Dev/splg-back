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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { RoleType } from '../../../common/constants/role-type.enum';
import { Auth } from '../../../common/decorators/auth.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { SinDistribuidora } from '../../../common/decorators/sin-distribuidora.decorator';
import { PermisoDePlataforma } from '../../../common/permisos/catalogo-de-plataforma';
import type { DownloadLinkResponseDto } from '../../../s3/dto/download-link.dto';
import { SoporteAdjuntos } from '../../application/soporte-adjuntos.service';
import { Party } from '../../domain/chat.enums';
import { ChatPresenter, comoPlataforma } from '../chat.presenter';
import { SendAttachmentDto } from '../dto/chat-attachment.dto';
import { MessageDto } from '../dto/chat-response.dto';
import {
  DESCRIPCION_DE_LA_SUBIDA,
  LecturaDeAdjunto,
  SubidaDeAdjunto,
} from './adjuntos.docs';

const TIPOS_DEL_SOPORTE =
  'PDF, JPG, PNG, WEBP, Word (.docx), Excel (.xlsx) o CSV';
const MENSAJE_NO_EXISTE =
  'el mensaje no existe o es de otra conversación, no tiene adjunto, se redactó o su archivo se bloqueó por virus';

/**
 * Adjuntos del soporte, lado de la plataforma (C1, D-C27). Sólo
 * administrador general, alcance `plataforma`: ve los chats y tickets de
 * todas las empresas, que son suyos.
 */
@ApiTags('Support attachments (platform)')
@Auth(RoleType.SUPER_ADMIN)
@SinDistribuidora()
@Controller({ path: 'platform', version: '2' })
export class PlatformSupportAttachmentsController {
  constructor(
    private readonly adjuntos: SoporteAdjuntos,
    private readonly presentar: ChatPresenter,
  ) {}

  @Post('chats/:id/attachments')
  @PermisoDePlataforma('plataforma.tickets.gestionar')
  @ApiOperation({
    summary: 'Mandar un archivo en el chat de una empresa',
    description: `${DESCRIPCION_DE_LA_SUBIDA} Cuenta como respuesta de la plataforma.`,
  })
  @SubidaDeAdjunto(TIPOS_DEL_SOPORTE)
  @ApiCreatedResponse({ type: MessageDto })
  @ApiOkResponse({ type: MessageDto, description: 'Reintento: ya estaba' })
  @ApiNotFoundResponse({ description: 'No existe ese chat' })
  @ApiConflictResponse({
    description: 'El chat está cerrado (`CONVERSATION_CLOSED`)',
  })
  async alChat(
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendAttachmentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MessageDto> {
    const r = await this.adjuntos.alChatComoPlataforma(userId, id, file, dto);
    res.status(r.created ? HttpStatus.CREATED : HttpStatus.OK);
    return this.presentar.mensaje(r.message, comoPlataforma(userId));
  }

  @Get('chats/:id/messages/:messageId/attachment')
  @PermisoDePlataforma('plataforma.tickets.ver')
  @ApiOperation({
    summary: 'URL para ver o bajar el adjunto de un mensaje del chat',
  })
  @LecturaDeAdjunto()
  @ApiNotFoundResponse({
    description: `No existe ese chat; ${MENSAJE_NO_EXISTE}`,
  })
  async enlaceDelChat(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ): Promise<DownloadLinkResponseDto> {
    return this.adjuntos.enlaceDelChat(Party.PLATFORM, null, id, messageId);
  }

  @Post('tickets/:id/attachments')
  @PermisoDePlataforma('plataforma.tickets.gestionar')
  @ApiOperation({
    summary: 'Mandar un archivo en el ticket',
    description: `${DESCRIPCION_DE_LA_SUBIDA} Es una respuesta (deja el ticket esperando a la empresa y le avisa); no hay adjuntos en notas internas.`,
  })
  @SubidaDeAdjunto(TIPOS_DEL_SOPORTE)
  @ApiCreatedResponse({ type: MessageDto })
  @ApiOkResponse({ type: MessageDto, description: 'Reintento: ya estaba' })
  @ApiNotFoundResponse({ description: 'No existe ese ticket' })
  @ApiConflictResponse({
    description: 'El ticket está cerrado (`TICKET_CLOSED`)',
  })
  async alTicket(
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendAttachmentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MessageDto> {
    const r = await this.adjuntos.alTicket(
      { party: Party.PLATFORM, userId, distributorId: null },
      id,
      file,
      dto,
    );
    res.status(r.created ? HttpStatus.CREATED : HttpStatus.OK);
    return this.presentar.mensaje(r.message, comoPlataforma(userId));
  }

  @Get('tickets/:id/messages/:messageId/attachment')
  @PermisoDePlataforma('plataforma.tickets.ver')
  @ApiOperation({
    summary: 'URL para ver o bajar el adjunto de un mensaje del ticket',
  })
  @LecturaDeAdjunto()
  @ApiNotFoundResponse({
    description: `No existe ese ticket; ${MENSAJE_NO_EXISTE}`,
  })
  async enlaceDelTicket(
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ): Promise<DownloadLinkResponseDto> {
    return this.adjuntos.enlaceDelTicket(
      { party: Party.PLATFORM, userId, distributorId: null },
      id,
      messageId,
    );
  }
}
