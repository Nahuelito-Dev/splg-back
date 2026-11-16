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
  'La conversación o el mensaje no existen, son de otra empresa o de otra persona (un chofer no ve las de los clientes); el mensaje no tiene adjunto, se redactó o su archivo se bloqueó por virus';
const NO_ES_DE_LA_APP =
  'La cuenta no es de un cliente o un chofer, o la empresa no tiene habilitados los mensajes (`MODULE_DISABLED`)';

/**
 * Adjuntos del cliente (C3) y del chofer (C2) en su conversación con la
 * empresa (CH7): fotos y PDF (comprobantes, remitos). Lo de otra empresa o de
 * otra persona es 404.
 */
@ApiTags('Inbox (apps)')
@RequiereModulo('chat')
@Auth(RoleType.CUSTOMER, RoleType.DELIVERY)
@Controller({ path: 'me/conversations', version: '2' })
export class MyAttachmentsController {
  constructor(
    private readonly acceso: BandejaAcceso,
    private readonly adjuntos: BandejaAdjuntos,
    private readonly presentar: BandejaPresenter,
  ) {}

  @Post(':id/attachments')
  @ApiOperation({
    summary: 'Mandar una foto o un PDF a la empresa',
    description: DESCRIPCION_DE_LA_SUBIDA,
  })
  @SubidaDeAdjunto('PDF, JPG, PNG o WEBP')
  @ApiCreatedResponse({ type: InboxMessageDto })
  @ApiOkResponse({ type: InboxMessageDto, description: 'Reintento: ya estaba' })
  @ApiForbiddenResponse({
    description: `${NO_ES_DE_LA_APP}; la empresa apagó el chat con los clientes (\`CUSTOMER_CHAT_DISABLED\`)`,
  })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  @ApiConflictResponse({
    description:
      'La conversación está cerrada (`CONVERSATION_CLOSED`) o ya no se puede escribir (`CHAT_NOT_WRITABLE`)',
  })
  async subir(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendAttachmentDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InboxMessageDto> {
    const actor = this.acceso.deLaPersona(user, distributorId);
    const r = await this.adjuntos.enviar(actor, id, file, dto);
    res.status(r.created ? HttpStatus.CREATED : HttpStatus.OK);
    return this.presentar.mensaje(r.message, lectorDe(actor));
  }

  @Get(':id/messages/:messageId/attachment')
  @ApiOperation({
    summary: 'URL para ver o bajar el adjunto de un mensaje',
    description:
      'URL firmada de corta vida. Leer sigue andando con el chat de clientes apagado.',
  })
  @LecturaDeAdjunto()
  @ApiForbiddenResponse({ description: NO_ES_DE_LA_APP })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  async enlace(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ): Promise<DownloadLinkResponseDto> {
    const actor = this.acceso.deLaPersona(user, distributorId);
    return this.adjuntos.enlace(actor, id, messageId);
  }
}
