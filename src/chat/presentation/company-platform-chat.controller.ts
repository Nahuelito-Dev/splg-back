import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { RoleType } from '../../common/constants/role-type.enum';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { Permiso } from '../../common/decorators/permiso.decorator';
import { SinControlDeAcceso } from '../../common/decorators/sin-control-de-acceso.decorator';
import { ChatThreadsService } from '../application/chat-threads.service';
import { PlatformChatService } from '../application/platform-chat.service';
import { SupportTicketsService } from '../application/support-tickets.service';
import { Channel, Party } from '../domain/chat.enums';
import { ChatPresenter, comoEmpresa } from './chat.presenter';
import {
  ChatPaginationDto,
  MessagesQueryDto,
  OpenTicketFromChatDto,
  ReadUpToDto,
  SendMessageDto,
} from './dto/chat-input.dto';
import {
  CompanyPlatformChatResponseDto,
  ConversationListResponseDto,
  MessageDto,
  MessageListResponseDto,
  TicketDto,
} from './dto/chat-response.dto';

/**
 * Chat en vivo con la plataforma, lado de la empresa (C1a, diseño §14.4).
 * Núcleo: anda aunque la empresa esté restringida o suspendida. El tenant es
 * el del perfil del admin; un chat de otra empresa es 404. Nunca devuelve
 * notas internas ni quién atiende más allá del nombre de pila.
 */
@ApiTags('Platform chat (company)')
@Auth(RoleType.ADMIN)
@SinControlDeAcceso()
@Controller({ path: 'company/platform-chat', version: '2' })
export class CompanyPlatformChatController {
  constructor(
    private readonly chats: PlatformChatService,
    private readonly hilos: ChatThreadsService,
    private readonly tickets: SupportTicketsService,
    private readonly presentar: ChatPresenter,
  ) {}

  @Get()
  @Permiso('soporte.ver')
  @ApiOperation({
    summary: 'El chat abierto con la plataforma',
    description:
      'Con los tickets que salieron de él (`ticketsFromHere`). `conversation: null` si no hay uno abierto: el próximo mensaje lo crea.',
  })
  @ApiOkResponse({ type: CompanyPlatformChatResponseDto })
  async abierto(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
  ): Promise<CompanyPlatformChatResponseDto> {
    const chat = await this.chats.abiertoDe(distributorId);
    return {
      conversation: chat
        ? await this.presentar.conversacion(chat, comoEmpresa(userId))
        : null,
    };
  }

  @Get('history')
  @Permiso('soporte.ver')
  @ApiOperation({
    summary: 'Chats cerrados con la plataforma',
    description: 'Los más recientes primero, paginado.',
  })
  @ApiOkResponse({ type: ConversationListResponseDto })
  @ApiBadRequestResponse({ description: 'Paginación fuera de rango' })
  async historial(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
    @Query() query: ChatPaginationDto,
  ): Promise<ConversationListResponseDto> {
    const { items, total } = await this.chats.historial(distributorId, query);
    return {
      items: await this.presentar.conversaciones(items, comoEmpresa(userId)),
      total,
    };
  }

  @Post('messages')
  @Permiso('soporte.gestionar')
  @ApiOperation({
    summary: 'Escribirle a la plataforma',
    description:
      'En el chat abierto o en uno nuevo. Reintentar con el mismo `clientMessageId` devuelve el mensaje ya guardado (200). Fuera del horario de la plataforma, el sistema responde una vez ofreciendo pasarlo a un ticket.',
  })
  @ApiCreatedResponse({ type: MessageDto })
  @ApiOkResponse({ type: MessageDto, description: 'Reintento: ya estaba' })
  @ApiBadRequestResponse({
    description: 'Texto vacío o de más de 2000 caracteres, o id que no es UUID',
  })
  @ApiTooManyRequestsResponse({
    description: 'Más de 30 mensajes por minuto (`CHAT_RATE_LIMITED`)',
  })
  async enviar(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
    @Body() dto: SendMessageDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MessageDto> {
    const r = await this.chats.enviarComoEmpresa(distributorId, userId, dto);
    res.status(r.created ? HttpStatus.CREATED : HttpStatus.OK);
    return this.presentar.mensaje(r.message, comoEmpresa(userId));
  }

  @Get(':conversationId/messages')
  @Permiso('soporte.ver')
  @ApiOperation({
    summary: 'Mensajes de un chat con la plataforma',
    description:
      'Por número: `afterSeq` (los posteriores, para reconectar) o `beforeSeq` (los anteriores); sin ninguno, los últimos. Siempre en orden de `seq`.',
  })
  @ApiOkResponse({ type: MessageListResponseDto })
  @ApiBadRequestResponse({
    description:
      'Id que no es UUID, `afterSeq` y `beforeSeq` juntos o `limit` fuera de 1–100',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otra empresa' })
  async mensajes(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Query() query: MessagesQueryDto,
  ): Promise<MessageListResponseDto> {
    const quien = comoEmpresa(userId);
    const chat = await this.hilos.buscar({
      conversationId,
      channel: Channel.PLATFORM_CHAT,
      distributorId,
    });
    const { items, hasMore } = await this.hilos.mensajes(chat, quien, query);
    return { items: await this.presentar.mensajes(items, quien), hasMore };
  }

  @Post(':conversationId/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permiso('soporte.ver')
  @ApiOperation({
    summary: 'Marcar leído hasta un mensaje',
    description:
      'La lectura es de cada persona; la plataforma ve como «leído» lo máximo que leyó alguien de la empresa. Nunca baja.',
  })
  @ApiNoContentResponse({ description: 'Listo' })
  @ApiBadRequestResponse({ description: 'Id que no es UUID o número negativo' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra empresa' })
  async leer(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: ReadUpToDto,
  ): Promise<void> {
    const chat = await this.hilos.buscar({
      conversationId,
      channel: Channel.PLATFORM_CHAT,
      distributorId,
    });
    await this.hilos.leer(chat, comoEmpresa(userId), dto.seq);
  }

  @Post(':conversationId/tickets')
  @Idempotent()
  @Permiso('soporte.gestionar')
  @ApiOperation({
    summary: 'Abrir un ticket desde el chat',
    description:
      'Con los mensajes `fromSeq`–`toSeq` del chat como contexto (se copian: el chat queda igual). El hilo del ticket arranca con esa cita; en el chat queda el aviso `ticket_opened` y los mensajes citados muestran el ticket (`citedInTickets`). Hasta 5 tickets por hora por empresa.',
  })
  @ApiCreatedResponse({ type: TicketDto })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos, o rango fuera del chat, invertido o de más de 200 mensajes (`TICKET_EXCERPT_INVALID`)',
  })
  @ApiNotFoundResponse({
    description: 'El chat no existe o es de otra empresa',
  })
  @ApiTooManyRequestsResponse({
    description: 'Más de 5 tickets en una hora (`TICKET_RATE_LIMITED`)',
  })
  async abrirTicket(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: OpenTicketFromChatDto,
  ): Promise<TicketDto> {
    const ticket = await this.tickets.crearDesdeElChat(
      { party: Party.COMPANY, userId, distributorId },
      conversationId,
      dto,
    );
    return this.presentar.ticket(ticket, comoEmpresa(userId));
  }
}
