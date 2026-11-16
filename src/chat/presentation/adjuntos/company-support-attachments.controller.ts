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
import { CurrentDistributor } from '../../../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Permiso } from '../../../common/decorators/permiso.decorator';
import { SinControlDeAcceso } from '../../../common/decorators/sin-control-de-acceso.decorator';
import type { DownloadLinkResponseDto } from '../../../s3/dto/download-link.dto';
import { SoporteAdjuntos } from '../../application/soporte-adjuntos.service';
import { Party } from '../../domain/chat.enums';
import { ChatPresenter, comoEmpresa } from '../chat.presenter';
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
 * Adjuntos del soporte, lado de la empresa (C1, D-C27): en el chat con la
 * plataforma y en el hilo de cada ticket. Núcleo: anda aunque la empresa esté
 * restringida o suspendida. Lo de otra empresa es 404.
 */
@ApiTags('Support attachments (company)')
@Auth(RoleType.ADMIN)
@SinControlDeAcceso()
@Controller({ path: 'company', version: '2' })
export class CompanySupportAttachmentsController {
  constructor(
    private readonly adjuntos: SoporteAdjuntos,
    private readonly presentar: ChatPresenter,
  ) {}

  @Post('platform-chat/:conversationId/attachments')
  @Permiso('soporte.gestionar')
  @ApiOperation({
    summary: 'Mandar un archivo en el chat con la plataforma',
    description: `${DESCRIPCION_DE_LA_SUBIDA} Va al chat indicado (el abierto): si se cerró, se escribe primero un texto, que abre otro.`,
  })
  @SubidaDeAdjunto(TIPOS_DEL_SOPORTE)
  @ApiCreatedResponse({ type: MessageDto })
  @ApiOkResponse({ type: MessageDto, description: 'Reintento: ya estaba' })
  @ApiNotFoundResponse({
    description: 'El chat no existe o es de otra empresa',
  })
  @ApiConflictResponse({
    description: 'El chat está cerrado (`CONVERSATION_CLOSED`)',
  })
  async alChat(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: SendAttachmentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MessageDto> {
    const r = await this.adjuntos.alChatComoEmpresa(
      distributorId,
      userId,
      conversationId,
      file,
      dto,
    );
    res.status(r.created ? HttpStatus.CREATED : HttpStatus.OK);
    return this.presentar.mensaje(r.message, comoEmpresa(userId));
  }

  @Get('platform-chat/:conversationId/messages/:messageId/attachment')
  @Permiso('soporte.ver')
  @ApiOperation({
    summary: 'URL para ver o bajar el adjunto de un mensaje del chat',
  })
  @LecturaDeAdjunto()
  @ApiNotFoundResponse({
    description: `El chat no existe o es de otra empresa; ${MENSAJE_NO_EXISTE}`,
  })
  async enlaceDelChat(
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ): Promise<DownloadLinkResponseDto> {
    return this.adjuntos.enlaceDelChat(
      Party.COMPANY,
      distributorId,
      conversationId,
      messageId,
    );
  }

  @Post('tickets/:id/attachments')
  @Permiso('soporte.gestionar')
  @ApiOperation({
    summary: 'Mandar un archivo en el ticket',
    description: `${DESCRIPCION_DE_LA_SUBIDA} Es una respuesta: si el ticket esperaba a la empresa o estaba resuelto, vuelve a \`open\`.`,
  })
  @SubidaDeAdjunto(TIPOS_DEL_SOPORTE)
  @ApiCreatedResponse({ type: MessageDto })
  @ApiOkResponse({ type: MessageDto, description: 'Reintento: ya estaba' })
  @ApiNotFoundResponse({
    description: 'El ticket no existe o es de otra empresa',
  })
  @ApiConflictResponse({
    description: 'El ticket está cerrado (`TICKET_CLOSED`)',
  })
  async alTicket(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendAttachmentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MessageDto> {
    const r = await this.adjuntos.alTicket(
      { party: Party.COMPANY, userId, distributorId },
      id,
      file,
      dto,
    );
    res.status(r.created ? HttpStatus.CREATED : HttpStatus.OK);
    return this.presentar.mensaje(r.message, comoEmpresa(userId));
  }

  @Get('tickets/:id/messages/:messageId/attachment')
  @Permiso('soporte.ver')
  @ApiOperation({
    summary: 'URL para ver o bajar el adjunto de un mensaje del ticket',
    description: 'Una nota interna de la plataforma no se ve (404).',
  })
  @LecturaDeAdjunto()
  @ApiNotFoundResponse({
    description: `El ticket no existe o es de otra empresa; ${MENSAJE_NO_EXISTE}`,
  })
  async enlaceDelTicket(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ): Promise<DownloadLinkResponseDto> {
    return this.adjuntos.enlaceDelTicket(
      { party: Party.COMPANY, userId, distributorId },
      id,
      messageId,
    );
  }
}
