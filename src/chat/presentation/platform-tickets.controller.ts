import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { SupportTicketsService } from '../application/support-tickets.service';
import { TicketActivityService } from '../application/ticket-activity.service';
import { TicketQueriesService } from '../application/ticket-queries.service';
import { Channel, Party } from '../domain/chat.enums';
import { ChatPresenter, comoPlataforma } from './chat.presenter';
import {
  AddExcerptDto,
  CreatePlatformTicketDto,
  MessagesQueryDto,
  PlatformTicketMessageDto,
  QueryPlatformTicketsDto,
  ReadUpToDto,
  UpdateTicketDto,
} from './dto/chat-input.dto';
import {
  MessageDto,
  MessageListResponseDto,
  PlatformTicketListResponseDto,
  TicketDto,
} from './dto/chat-response.dto';

/**
 * Tickets de soporte, lado de la plataforma (C1b, diseño §14.5). Sólo
 * administrador general, alcance `plataforma`. Ve los de todas las empresas,
 * con las notas internas.
 */
@ApiTags('Support tickets (platform)')
@Auth(RoleType.SUPER_ADMIN)
@SinDistribuidora()
@Controller({ path: 'platform/tickets', version: '2' })
export class PlatformTicketsController {
  constructor(
    private readonly apertura: SupportTicketsService,
    private readonly actividad: TicketActivityService,
    private readonly consultas: TicketQueriesService,
    private readonly hilos: ChatThreadsService,
    private readonly presentar: ChatPresenter,
  ) {}

  @Get()
  @PermisoDePlataforma('plataforma.tickets.ver')
  @ApiOperation({
    summary: 'Cola de tickets',
    description:
      'Por defecto, los movidos más recientemente primero (`sort` y `order` lo cambian). Filtros: `status` (uno o varios, separados por coma), `priority`, `distributorId`, `assigned` (`me`, `none` o un id), `overdue` (objetivo de primera respuesta vencido), `fromChat` y `q` (número o asunto). `counts` no depende de los filtros.',
  })
  @ApiOkResponse({ type: PlatformTicketListResponseDto })
  @ApiBadRequestResponse({
    description:
      'Filtro inválido (estado, prioridad, `assigned`, `q` de más de 120 caracteres), `sort`/`order` desconocidos o paginación fuera de rango',
  })
  async listar(
    @CurrentUser('user_id') userId: string,
    @Query() query: QueryPlatformTicketsDto,
  ): Promise<PlatformTicketListResponseDto> {
    const { items, total, counts } = await this.consultas.deLaPlataforma(
      userId,
      query,
    );
    return {
      items: await this.presentar.tickets(items, comoPlataforma(userId)),
      total,
      counts,
    };
  }

  @Post()
  @PermisoDePlataforma('plataforma.tickets.gestionar')
  @ApiOperation({
    summary: 'Abrirle un ticket a una empresa',
    description:
      'Queda esperando a la empresa y asignado a quien lo abre; la empresa recibe el aviso en su bandeja y por correo. Reintentar con el mismo `firstMessage.clientMessageId` devuelve el ticket ya creado (200).',
  })
  @ApiCreatedResponse({ type: TicketDto })
  @ApiOkResponse({ type: TicketDto, description: 'Reintento: ya estaba' })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiNotFoundResponse({
    description: 'La empresa no existe o está dada de baja',
  })
  async crear(
    @CurrentUser('user_id') userId: string,
    @Body() dto: CreatePlatformTicketDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TicketDto> {
    const { ticket, created } = await this.apertura.crear(
      { party: Party.PLATFORM, userId, distributorId: null },
      dto,
    );
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return this.presentar.ticket(ticket, comoPlataforma(userId));
  }

  @Get(':id')
  @PermisoDePlataforma('plataforma.tickets.ver')
  @ApiOperation({ summary: 'Ficha de un ticket' })
  @ApiOkResponse({ type: TicketDto })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiNotFoundResponse({ description: 'No existe ese ticket' })
  async ficha(
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TicketDto> {
    return this.presentar.ticket(
      await this.consultas.ficha(id, null),
      comoPlataforma(userId),
    );
  }

  @Get(':id/messages')
  @PermisoDePlataforma('plataforma.tickets.ver')
  @ApiOperation({
    summary: 'Hilo del ticket',
    description: 'Con las notas internas (`visibility: internal`).',
  })
  @ApiOkResponse({ type: MessageListResponseDto })
  @ApiBadRequestResponse({
    description:
      'Id que no es UUID, `afterSeq` y `beforeSeq` juntos o `limit` fuera de 1–100',
  })
  @ApiNotFoundResponse({ description: 'No existe ese ticket' })
  async mensajes(
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: MessagesQueryDto,
  ): Promise<MessageListResponseDto> {
    const quien = comoPlataforma(userId);
    const ticket = await this.consultas.ficha(id, null);
    const hilo = await this.hilos.buscar({
      conversationId: ticket.conversationId,
      channel: Channel.PLATFORM_TICKET,
      distributorId: null,
    });
    const { items, hasMore } = await this.hilos.mensajes(hilo, quien, query);
    return { items: await this.presentar.mensajes(items, quien), hasMore };
  }

  @Post(':id/messages')
  @PermisoDePlataforma('plataforma.tickets.gestionar')
  @ApiOperation({
    summary: 'Responder en el ticket o dejar una nota interna',
    description:
      'Una respuesta (`visibility: all`) deja el ticket esperando a la empresa, registra la primera respuesta y lo asigna a quien responde si no tenía a nadie; la empresa recibe aviso. Una nota interna no cambia nada y la empresa no la ve.',
  })
  @ApiCreatedResponse({ type: MessageDto })
  @ApiOkResponse({ type: MessageDto, description: 'Reintento: ya estaba' })
  @ApiBadRequestResponse({ description: 'Texto o visibilidad inválidos' })
  @ApiNotFoundResponse({ description: 'No existe ese ticket' })
  @ApiConflictResponse({
    description: 'El ticket está cerrado (`TICKET_CLOSED`)',
  })
  @ApiTooManyRequestsResponse({
    description: 'Más de 30 mensajes por minuto (`CHAT_RATE_LIMITED`)',
  })
  async responder(
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PlatformTicketMessageDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MessageDto> {
    const r = await this.actividad.responder(
      { party: Party.PLATFORM, userId, distributorId: null },
      id,
      dto,
      dto.visibility,
    );
    res.status(r.created ? HttpStatus.CREATED : HttpStatus.OK);
    return this.presentar.mensaje(r.message, comoPlataforma(userId));
  }

  @Post(':id/excerpts')
  @Idempotent()
  @PermisoDePlataforma('plataforma.tickets.gestionar')
  @ApiOperation({
    summary: 'Llevar más mensajes del chat de la empresa al ticket',
    description:
      'Sólo un chat de la misma empresa que el ticket (otro es 404).',
  })
  @ApiCreatedResponse({ type: MessageDto })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos o rango fuera del chat, invertido o de más de 200 mensajes (`TICKET_EXCERPT_INVALID`)',
  })
  @ApiNotFoundResponse({
    description:
      'El ticket no existe, o el chat no es de la empresa del ticket',
  })
  @ApiConflictResponse({
    description: 'El ticket está cerrado (`TICKET_CLOSED`)',
  })
  async citar(
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddExcerptDto,
  ): Promise<MessageDto> {
    const mensaje = await this.apertura.agregarCita(
      { party: Party.PLATFORM, userId, distributorId: null },
      id,
      dto,
    );
    return this.presentar.mensaje(mensaje, comoPlataforma(userId));
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @PermisoDePlataforma('plataforma.tickets.ver')
  @ApiOperation({ summary: 'Marcar leído el hilo del ticket hasta un mensaje' })
  @ApiNoContentResponse({ description: 'Listo' })
  @ApiBadRequestResponse({ description: 'Id que no es UUID o número negativo' })
  @ApiNotFoundResponse({ description: 'No existe ese ticket' })
  async leer(
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReadUpToDto,
  ): Promise<void> {
    const ticket = await this.consultas.ficha(id, null);
    const hilo = await this.hilos.buscar({
      conversationId: ticket.conversationId,
      channel: Channel.PLATFORM_TICKET,
      distributorId: null,
    });
    await this.hilos.leer(hilo, comoPlataforma(userId), dto.seq);
  }

  @Patch(':id')
  @PermisoDePlataforma('plataforma.tickets.gestionar')
  @ApiOperation({
    summary: 'Cambiar estado, prioridad, asignación o categoría',
    description:
      'El estado sigue la máquina del ticket (`new → open | waiting_company`, `open → waiting_company | resolved`, `waiting_company → open | resolved`, `resolved → open`). `closed` no se acepta a mano (400 `TICKET_INVALID_TRANSITION`): el ticket se cierra solo a los 7 días (plazo configurable) o cuando la empresa confirma la resolución. Asignar un ticket nuevo lo pasa a `open`. Cambiar la prioridad sin primera respuesta recalcula el vencimiento.',
  })
  @ApiOkResponse({ type: TicketDto })
  @ApiBadRequestResponse({
    description:
      'Sin cambios, valor desconocido, transición inválida o pedido de `closed` (`TICKET_INVALID_TRANSITION`) o asignado que no es del equipo de la plataforma (`TICKET_ASSIGNEE_INVALID`)',
  })
  @ApiNotFoundResponse({ description: 'No existe ese ticket' })
  @ApiConflictResponse({
    description: 'El ticket está cerrado (`TICKET_CLOSED`)',
  })
  async actualizar(
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTicketDto,
  ): Promise<TicketDto> {
    return this.presentar.ticket(
      await this.actividad.actualizar(userId, id, dto),
      comoPlataforma(userId),
    );
  }
}
