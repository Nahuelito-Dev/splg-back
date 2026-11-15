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
  ApiConflictResponse,
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
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { SinDistribuidora } from '../../common/decorators/sin-distribuidora.decorator';
import { PermisoDePlataforma } from '../../common/permisos/catalogo-de-plataforma';
import { ChatThreadsService } from '../application/chat-threads.service';
import { PlatformChatService } from '../application/platform-chat.service';
import { SupportTicketsService } from '../application/support-tickets.service';
import { TicketQueriesService } from '../application/ticket-queries.service';
import { Channel, Party } from '../domain/chat.enums';
import { ChatPresenter, comoPlataforma } from './chat.presenter';
import {
  MessagesQueryDto,
  PlatformOpenTicketFromChatDto,
  QueryPlatformChatsDto,
  ReadUpToDto,
  SendMessageDto,
  StartPlatformChatDto,
} from './dto/chat-input.dto';
import {
  ConversationDto,
  MessageDto,
  MessageListResponseDto,
  PlatformChatListResponseDto,
  TicketDto,
} from './dto/chat-response.dto';

/**
 * Chat en vivo con las empresas, lado de la plataforma (C1a, diseño §14.5).
 * Sólo administrador general, alcance `plataforma`: no lee `X-Distributor`
 * ni `X-Support-Session` (ve los chats de todas las empresas, que son suyos).
 */
@ApiTags('Platform chat (platform)')
@Auth(RoleType.SUPER_ADMIN)
@SinDistribuidora()
@Controller({ path: 'platform/chats', version: '2' })
export class PlatformChatsController {
  constructor(
    private readonly chats: PlatformChatService,
    private readonly consultas: TicketQueriesService,
    private readonly hilos: ChatThreadsService,
    private readonly tickets: SupportTicketsService,
    private readonly presentar: ChatPresenter,
  ) {}

  @Get()
  @PermisoDePlataforma('plataforma.tickets.ver')
  @ApiOperation({
    summary: 'Chats con las empresas',
    description:
      'Por defecto los abiertos, con el último mensaje más reciente primero. Filtros: `status`, `assigned` (`me`, `none` o el id de un miembro) y `distributorId`. `counts`: abiertos sin atender y los que atiendo.',
  })
  @ApiOkResponse({ type: PlatformChatListResponseDto })
  @ApiBadRequestResponse({
    description:
      'Estado desconocido, `assigned` o `distributorId` mal formados, paginación fuera de rango',
  })
  async listar(
    @CurrentUser('user_id') userId: string,
    @Query() query: QueryPlatformChatsDto,
  ): Promise<PlatformChatListResponseDto> {
    const { items, total, counts } = await this.consultas.chats(userId, query);
    return {
      items: await this.presentar.conversaciones(items, comoPlataforma(userId)),
      total,
      counts,
    };
  }

  @Post()
  @PermisoDePlataforma('plataforma.tickets.gestionar')
  @ApiOperation({
    summary: 'Escribirle a una empresa',
    description:
      'En su chat abierto o en uno nuevo, que queda atendido por quien escribe. Reintentar con el mismo `clientMessageId` devuelve el mensaje ya guardado (200).',
  })
  @ApiCreatedResponse({ type: MessageDto })
  @ApiOkResponse({ type: MessageDto, description: 'Reintento: ya estaba' })
  @ApiBadRequestResponse({
    description: 'Empresa que no es UUID o mensaje inválido',
  })
  @ApiNotFoundResponse({
    description: 'La empresa no existe o está dada de baja',
  })
  @ApiTooManyRequestsResponse({
    description: 'Más de 30 mensajes por minuto (`CHAT_RATE_LIMITED`)',
  })
  async escribir(
    @CurrentUser('user_id') userId: string,
    @Body() dto: StartPlatformChatDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MessageDto> {
    const r = await this.chats.enviarComoPlataforma(
      dto.distributorId,
      userId,
      dto.firstMessage,
    );
    res.status(r.created ? HttpStatus.CREATED : HttpStatus.OK);
    return this.presentar.mensaje(r.message, comoPlataforma(userId));
  }

  @Get(':id')
  @PermisoDePlataforma('plataforma.tickets.ver')
  @ApiOperation({ summary: 'Un chat con una empresa' })
  @ApiOkResponse({ type: ConversationDto })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiNotFoundResponse({ description: 'No existe ese chat' })
  async ficha(
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationDto> {
    const chat = await this.hilos.buscar({
      conversationId: id,
      channel: Channel.PLATFORM_CHAT,
      distributorId: null,
    });
    return this.presentar.conversacion(chat, comoPlataforma(userId));
  }

  @Get(':id/messages')
  @PermisoDePlataforma('plataforma.tickets.ver')
  @ApiOperation({
    summary: 'Mensajes de un chat',
    description:
      'Por número: `afterSeq` o `beforeSeq`; sin ninguno, los últimos.',
  })
  @ApiOkResponse({ type: MessageListResponseDto })
  @ApiBadRequestResponse({
    description:
      'Id que no es UUID, `afterSeq` y `beforeSeq` juntos o `limit` fuera de 1–100',
  })
  @ApiNotFoundResponse({ description: 'No existe ese chat' })
  async mensajes(
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: MessagesQueryDto,
  ): Promise<MessageListResponseDto> {
    const quien = comoPlataforma(userId);
    const chat = await this.hilos.buscar({
      conversationId: id,
      channel: Channel.PLATFORM_CHAT,
      distributorId: null,
    });
    const { items, hasMore } = await this.hilos.mensajes(chat, quien, query);
    return { items: await this.presentar.mensajes(items, quien), hasMore };
  }

  @Post(':id/messages')
  @PermisoDePlataforma('plataforma.tickets.gestionar')
  @ApiOperation({
    summary: 'Responder en un chat',
    description:
      'La primera respuesta queda registrada para medir la espera. Reintentar con el mismo `clientMessageId` devuelve el mensaje ya guardado (200).',
  })
  @ApiCreatedResponse({ type: MessageDto })
  @ApiOkResponse({ type: MessageDto, description: 'Reintento: ya estaba' })
  @ApiBadRequestResponse({
    description: 'Id que no es UUID o mensaje inválido',
  })
  @ApiNotFoundResponse({ description: 'No existe ese chat' })
  @ApiConflictResponse({
    description: 'El chat está cerrado (`CONVERSATION_CLOSED`)',
  })
  @ApiTooManyRequestsResponse({
    description: 'Más de 30 mensajes por minuto (`CHAT_RATE_LIMITED`)',
  })
  async responder(
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MessageDto> {
    const r = await this.chats.responder(id, userId, dto);
    res.status(r.created ? HttpStatus.CREATED : HttpStatus.OK);
    return this.presentar.mensaje(r.message, comoPlataforma(userId));
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @PermisoDePlataforma('plataforma.tickets.ver')
  @ApiOperation({ summary: 'Marcar leído un chat hasta un mensaje' })
  @ApiNoContentResponse({ description: 'Listo' })
  @ApiBadRequestResponse({ description: 'Id que no es UUID o número negativo' })
  @ApiNotFoundResponse({ description: 'No existe ese chat' })
  async leer(
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReadUpToDto,
  ): Promise<void> {
    const chat = await this.hilos.buscar({
      conversationId: id,
      channel: Channel.PLATFORM_CHAT,
      distributorId: null,
    });
    await this.hilos.leer(chat, comoPlataforma(userId), dto.seq);
  }

  @Post(':id/take')
  @HttpCode(HttpStatus.OK)
  @PermisoDePlataforma('plataforma.tickets.gestionar')
  @ApiOperation({
    summary: 'Tomar un chat',
    description:
      'Quien lo toma lo atiende; la empresa ve su nombre de pila. Tomar uno propio no cambia nada.',
  })
  @ApiOkResponse({ type: ConversationDto })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiNotFoundResponse({ description: 'No existe ese chat' })
  @ApiConflictResponse({
    description:
      'Cerrado (`CONVERSATION_CLOSED`) o ya lo atiende otra persona (`CONVERSATION_ALREADY_TAKEN`)',
  })
  async tomar(
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationDto> {
    return this.presentar.conversacion(
      await this.chats.tomar(id, userId),
      comoPlataforma(userId),
    );
  }

  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  @PermisoDePlataforma('plataforma.tickets.gestionar')
  @ApiOperation({
    summary: 'Soltar un chat',
    description: 'Vuelve a la cola sin nadie atendiendo.',
  })
  @ApiOkResponse({ type: ConversationDto })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiNotFoundResponse({ description: 'No existe ese chat' })
  @ApiConflictResponse({ description: 'Cerrado (`CONVERSATION_CLOSED`)' })
  async soltar(
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationDto> {
    return this.presentar.conversacion(
      await this.chats.soltar(id, userId),
      comoPlataforma(userId),
    );
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @PermisoDePlataforma('plataforma.tickets.gestionar')
  @ApiOperation({
    summary: 'Cerrar un chat',
    description:
      'No cierra los tickets que salieron de él. El próximo mensaje de cualquiera de las dos puntas abre otro.',
  })
  @ApiOkResponse({ type: ConversationDto })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiNotFoundResponse({ description: 'No existe ese chat' })
  @ApiConflictResponse({
    description: 'Ya estaba cerrado (`CONVERSATION_CLOSED`)',
  })
  async cerrar(
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationDto> {
    return this.presentar.conversacion(
      await this.chats.cerrar(id, userId),
      comoPlataforma(userId),
    );
  }

  @Post(':id/tickets')
  @Idempotent()
  @PermisoDePlataforma('plataforma.tickets.gestionar')
  @ApiOperation({
    summary: 'Abrir un ticket desde un chat',
    description:
      'Con los mensajes `fromSeq`–`toSeq` como contexto (se copian). Queda esperando a la empresa; con `assignToMe`, asignado a quien lo abre.',
  })
  @ApiCreatedResponse({ type: TicketDto })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos, o rango fuera del chat, invertido o de más de 200 mensajes (`TICKET_EXCERPT_INVALID`)',
  })
  @ApiNotFoundResponse({ description: 'No existe ese chat' })
  async abrirTicket(
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PlatformOpenTicketFromChatDto,
  ): Promise<TicketDto> {
    const ticket = await this.tickets.crearDesdeElChat(
      { party: Party.PLATFORM, userId, distributorId: null },
      id,
      dto,
    );
    return this.presentar.ticket(ticket, comoPlataforma(userId));
  }
}
