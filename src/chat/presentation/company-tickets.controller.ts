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
import { CurrentDistributor } from '../../common/decorators/current-distributor.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { Permiso } from '../../common/decorators/permiso.decorator';
import { SinControlDeAcceso } from '../../common/decorators/sin-control-de-acceso.decorator';
import { ChatThreadsService } from '../application/chat-threads.service';
import { SupportTicketsService } from '../application/support-tickets.service';
import { TicketActivityService } from '../application/ticket-activity.service';
import { TicketQueriesService } from '../application/ticket-queries.service';
import { Channel, Party } from '../domain/chat.enums';
import { ChatPresenter, comoEmpresa } from './chat.presenter';
import {
  AddExcerptDto,
  ConfirmTicketDto,
  CreateCompanyTicketDto,
  MessagesQueryDto,
  QueryCompanyTicketsDto,
  ReadUpToDto,
  SendMessageDto,
} from './dto/chat-input.dto';
import {
  MessageDto,
  MessageListResponseDto,
  TicketDto,
  TicketListResponseDto,
} from './dto/chat-response.dto';

/**
 * Tickets de soporte, lado de la empresa (C1b, diseño §14.4). Núcleo: anda
 * aunque la empresa esté restringida o suspendida. Un ticket de otra empresa
 * es 404; la empresa nunca recibe las notas internas de la plataforma.
 */
@ApiTags('Support tickets (company)')
@Auth(RoleType.ADMIN)
@SinControlDeAcceso()
@Controller({ path: 'company/tickets', version: '2' })
export class CompanyTicketsController {
  constructor(
    private readonly apertura: SupportTicketsService,
    private readonly actividad: TicketActivityService,
    private readonly consultas: TicketQueriesService,
    private readonly hilos: ChatThreadsService,
    private readonly presentar: ChatPresenter,
  ) {}

  @Get()
  @Permiso('soporte.ver')
  @ApiOperation({
    summary: 'Tickets de mi empresa',
    description:
      'Por defecto, los movidos más recientemente primero. Filtros: `status` (uno o varios, separados por coma) y `q` (número `T-000123`/`123` o parte del asunto). Orden: `sort` (`createdAt`, `updatedAt`, `lastMessageAt`) y `order` (`asc`, `desc`). Sólo los de mi empresa.',
  })
  @ApiOkResponse({ type: TicketListResponseDto })
  @ApiBadRequestResponse({
    description:
      'Estado desconocido o vacío, `q` de más de 120 caracteres, `sort`/`order` desconocidos o paginación fuera de rango',
  })
  async listar(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
    @Query() query: QueryCompanyTicketsDto,
  ): Promise<TicketListResponseDto> {
    const { items, total } = await this.consultas.deLaEmpresa(
      distributorId,
      query,
    );
    return {
      items: await this.presentar.resumenes(items, comoEmpresa(userId)),
      total,
    };
  }

  @Post()
  @Permiso('soporte.gestionar')
  @ApiOperation({
    summary: 'Abrir un ticket',
    description:
      'Queda `new` hasta que la plataforma lo tome. Reintentar con el mismo `firstMessage.clientMessageId` devuelve el ticket ya creado (200). Hasta 5 tickets por hora por empresa.',
  })
  @ApiCreatedResponse({ type: TicketDto })
  @ApiOkResponse({ type: TicketDto, description: 'Reintento: ya estaba' })
  @ApiBadRequestResponse({
    description:
      'Categoría o prioridad desconocida, asunto fuera de 5–120 caracteres o primer mensaje inválido',
  })
  @ApiTooManyRequestsResponse({
    description: 'Más de 5 tickets en una hora (`TICKET_RATE_LIMITED`)',
  })
  async crear(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
    @Body() dto: CreateCompanyTicketDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TicketDto> {
    const { ticket, created } = await this.apertura.crear(
      { party: Party.COMPANY, userId, distributorId },
      { ...dto, distributorId },
    );
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return this.presentar.ticket(ticket, comoEmpresa(userId));
  }

  @Get(':id')
  @Permiso('soporte.ver')
  @ApiOperation({
    summary: 'Ficha de un ticket',
    description:
      'Con su chat de origen (si salió de uno) y las sesiones de soporte pedidas con su número.',
  })
  @ApiOkResponse({ type: TicketDto })
  @ApiBadRequestResponse({ description: 'El id no es un UUID' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra empresa' })
  async ficha(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TicketDto> {
    return this.presentar.ticket(
      await this.consultas.ficha(id, distributorId),
      comoEmpresa(userId),
    );
  }

  @Get(':id/messages')
  @Permiso('soporte.ver')
  @ApiOperation({
    summary: 'Hilo del ticket',
    description:
      'Sin las notas internas de la plataforma. Por número: `afterSeq` o `beforeSeq`.',
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
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: MessagesQueryDto,
  ): Promise<MessageListResponseDto> {
    const quien = comoEmpresa(userId);
    const ticket = await this.consultas.ficha(id, distributorId);
    const hilo = await this.hilos.buscar({
      conversationId: ticket.conversationId,
      channel: Channel.PLATFORM_TICKET,
      distributorId,
    });
    const { items, hasMore } = await this.hilos.mensajes(hilo, quien, query);
    return { items: await this.presentar.mensajes(items, quien), hasMore };
  }

  @Post(':id/messages')
  @Permiso('soporte.gestionar')
  @ApiOperation({
    summary: 'Responder en el ticket',
    description:
      'Si el ticket esperaba a la empresa o estaba resuelto, vuelve a `open`. Reintentar con el mismo `clientMessageId` devuelve el mensaje ya guardado (200).',
  })
  @ApiCreatedResponse({ type: MessageDto })
  @ApiOkResponse({ type: MessageDto, description: 'Reintento: ya estaba' })
  @ApiBadRequestResponse({
    description: 'Texto vacío o de más de 2000 caracteres',
  })
  @ApiNotFoundResponse({ description: 'No existe o es de otra empresa' })
  @ApiConflictResponse({
    description: 'El ticket está cerrado (`TICKET_CLOSED`)',
  })
  @ApiTooManyRequestsResponse({
    description: 'Más de 30 mensajes por minuto (`CHAT_RATE_LIMITED`)',
  })
  async responder(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MessageDto> {
    const r = await this.actividad.responder(
      { party: Party.COMPANY, userId, distributorId },
      id,
      dto,
    );
    res.status(r.created ? HttpStatus.CREATED : HttpStatus.OK);
    return this.presentar.mensaje(r.message, comoEmpresa(userId));
  }

  @Post(':id/excerpts')
  @Idempotent()
  @Permiso('soporte.gestionar')
  @ApiOperation({
    summary: 'Llevar más mensajes del chat al ticket',
    description:
      'Copia `fromSeq`–`toSeq` de un chat de mi empresa al hilo del ticket (el chat queda igual).',
  })
  @ApiCreatedResponse({ type: MessageDto })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos o rango fuera del chat, invertido o de más de 200 mensajes (`TICKET_EXCERPT_INVALID`)',
  })
  @ApiNotFoundResponse({
    description: 'El ticket o el chat no existen o son de otra empresa',
  })
  @ApiConflictResponse({
    description: 'El ticket está cerrado (`TICKET_CLOSED`)',
  })
  async citar(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddExcerptDto,
  ): Promise<MessageDto> {
    const mensaje = await this.apertura.agregarCita(
      { party: Party.COMPANY, userId, distributorId },
      id,
      dto,
    );
    return this.presentar.mensaje(mensaje, comoEmpresa(userId));
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permiso('soporte.ver')
  @ApiOperation({ summary: 'Marcar leído el hilo del ticket hasta un mensaje' })
  @ApiNoContentResponse({ description: 'Listo' })
  @ApiBadRequestResponse({ description: 'Id que no es UUID o número negativo' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra empresa' })
  async leer(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReadUpToDto,
  ): Promise<void> {
    const ticket = await this.consultas.ficha(id, distributorId);
    const hilo = await this.hilos.buscar({
      conversationId: ticket.conversationId,
      channel: Channel.PLATFORM_TICKET,
      distributorId,
    });
    await this.hilos.leer(hilo, comoEmpresa(userId), dto.seq);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @Permiso('soporte.gestionar')
  @ApiOperation({
    summary: 'Confirmar un ticket resuelto',
    description: 'Lo cierra. Se puede calificar la atención de 1 a 5.',
  })
  @ApiOkResponse({ type: TicketDto })
  @ApiBadRequestResponse({ description: 'Calificación fuera de 1–5' })
  @ApiNotFoundResponse({ description: 'No existe o es de otra empresa' })
  @ApiConflictResponse({
    description: 'El ticket no está resuelto (`TICKET_NOT_RESOLVED`)',
  })
  async confirmar(
    @CurrentDistributor({ required: true }) distributorId: string,
    @CurrentUser('user_id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmTicketDto,
  ): Promise<TicketDto> {
    const ticket = await this.actividad.confirmar(
      distributorId,
      id,
      dto.satisfaction,
    );
    return this.presentar.ticket(ticket, comoEmpresa(userId));
  }
}
