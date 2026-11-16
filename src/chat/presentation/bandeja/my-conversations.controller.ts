import {
  Body,
  Controller,
  Delete,
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
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
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
import { BandejaAcceso, lectorDe } from '../../application/bandeja-acceso';
import { BandejaGestionService } from '../../application/bandeja-gestion.service';
import { BandejaService } from '../../application/bandeja.service';
import { BandejaEncuestaService } from '../../application/bandeja-encuesta.service';
import { BandejaPresenter, encuestaADto } from '../bandeja.presenter';
import {
  EditMessageDto,
  OpenMyConversationDto,
  QueryMyConversationsDto,
  RateConversationDto,
  SendCustomerActionDto,
  SendInboxMessageDto,
} from '../dto/bandeja-input.dto';
import {
  ConversationRatingResponseDto,
  CustomerActionListResponseDto,
  InboxConversationDto,
  InboxMessageDto,
  InboxMessageListResponseDto,
  MyConversationListResponseDto,
  OpenConversationResponseDto,
} from '../dto/bandeja-response.dto';
import { MessagesQueryDto, ReadUpToDto } from '../dto/chat-input.dto';

const NO_EXISTE = 'No existe, es de otra empresa o de otra persona';
const RAPIDO =
  'Más de 30 mensajes por minuto, o más de 10 por minuto en una misma conversación (`CHAT_RATE_LIMITED`)';

/**
 * Las conversaciones del cliente (C3) y del chofer (C2) con su empresa
 * (diseño §14.2). El cliente habla con la empresa del `X-Distributor`; el
 * chofer, con la de su perfil. Del otro lado se ve la empresa, nunca el
 * operador (D-C5). Lo de otra empresa o de otra persona es 404. Módulo `chat`.
 */
@ApiTags('Inbox (apps)')
@RequiereModulo('chat')
@Auth(RoleType.CUSTOMER, RoleType.DELIVERY)
@Controller({ path: 'me/conversations', version: '2' })
export class MyConversationsController {
  constructor(
    private readonly acceso: BandejaAcceso,
    private readonly bandeja: BandejaService,
    private readonly gestion: BandejaGestionService,
    private readonly presentar: BandejaPresenter,
    private readonly encuesta: BandejaEncuestaService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Mis conversaciones con la empresa',
    description:
      'El cliente, las suyas con la empresa del `X-Distributor`; el chofer, las suyas con la de su perfil. Por el último mensaje.',
  })
  @ApiOkResponse({ type: MyConversationListResponseDto })
  @ApiBadRequestResponse({
    description:
      'Estado, fecha o paginación inválidos; el cliente sin `X-Distributor` (`MISSING_DISTRIBUTOR`)',
  })
  async listar(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Query() query: QueryMyConversationsDto,
  ): Promise<MyConversationListResponseDto> {
    const actor = this.acceso.deLaPersona(user, distributorId);
    const { items, total } = await this.gestion.misConversaciones(actor, query);
    return {
      items: await this.presentar.conversaciones(items, lectorDe(actor)),
      total,
    };
  }

  @Post()
  @ApiOperation({
    summary: 'Escribirle a la empresa',
    description:
      '`general`: el cliente necesita un vínculo vigente o algún pedido con la empresa (si no, 404); el chofer, ser de la empresa. `order`: un pedido propio (el del cliente, o el que lleva el chofer), hasta 30 días después de entregado o cancelado. Con una abierta del mismo tema se agrega el mensaje (200); si no, se crea (201). El mismo `clientMessageId` repetido devuelve el mensaje ya guardado (200).',
  })
  @ApiCreatedResponse({ type: OpenConversationResponseDto })
  @ApiOkResponse({
    type: OpenConversationResponseDto,
    description: 'Ya había una abierta del mismo tema, o es un reintento',
  })
  @ApiBadRequestResponse({
    description:
      'Ámbito inválido, pedido en una general o sin pedido en una por pedido, texto vacío o de más de 2000, `replyToSeq` que no existe (`REPLY_TO_INVALID`); el cliente sin `X-Distributor`',
  })
  @ApiForbiddenResponse({
    description:
      'La cuenta no es de un cliente o un chofer; la empresa apagó el chat con los clientes (`CUSTOMER_CHAT_DISABLED`)',
  })
  @ApiNotFoundResponse({
    description:
      'Sin vínculo ni pedidos con la empresa, o el pedido no es propio o es de otra empresa',
  })
  @ApiConflictResponse({
    description:
      'Pasaron 30 días desde que el pedido se entregó o se canceló (`ORDER_CHAT_WINDOW_CLOSED`)',
  })
  @ApiTooManyRequestsResponse({ description: RAPIDO })
  async abrir(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Body() dto: OpenMyConversationDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OpenConversationResponseDto> {
    const actor = this.acceso.deLaPersona(user, distributorId);
    const r = await this.bandeja.abrirDeLaPersona(actor, dto);
    res.status(r.conversationCreated ? HttpStatus.CREATED : HttpStatus.OK);
    const lector = lectorDe(actor);
    return {
      conversation: await this.presentar.conversacion(r.conversation, lector),
      message: await this.presentar.mensaje(r.message, lector),
    };
  }

  @Get('actions')
  @ApiOperation({
    summary: 'Botones de acción del chat (cliente)',
    description:
      'Para mostrar al abrir un chat nuevo: los que muestra la empresa del `X-Distributor` («¿Dónde está mi pedido?», «Repetir mi último pedido», «Medios de pago», «Hablar con una persona»), en orden. `kind: app` lo abre la app (el chat no crea pedidos). Lista vacía si la empresa no muestra ninguno o no atiende por chat. También llegan en `actions` del primer mensaje del asistente de cada conversación.',
  })
  @ApiOkResponse({ type: CustomerActionListResponseDto })
  @ApiBadRequestResponse({
    description: 'El cliente sin `X-Distributor` (`MISSING_DISTRIBUTOR`)',
  })
  @ApiForbiddenResponse({
    description:
      'La cuenta no es de un cliente o un chofer; el chofer (`CUSTOMER_ONLY`); o la empresa no tiene habilitados los mensajes (`MODULE_DISABLED`)',
  })
  async acciones(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<CustomerActionListResponseDto> {
    const actor = this.acceso.deLaPersona(user, distributorId);
    const items = await this.bandeja.acciones(actor);
    return {
      items: items.map(({ key, label, kind, text }) => ({
        key,
        label,
        kind,
        text,
      })),
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Una conversación mía' })
  @ApiOkResponse({ type: InboxConversationDto })
  @ApiBadRequestResponse({ description: 'Id que no es uuid' })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  async una(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InboxConversationDto> {
    const actor = this.acceso.deLaPersona(user, distributorId);
    const c = await this.bandeja.conversacion(actor, id);
    return this.presentar.conversacion(c, lectorDe(actor));
  }

  @Get(':id/messages')
  @ApiOperation({
    summary: 'Mensajes de una conversación mía',
    description:
      '`afterSeq` (reconexión) o `beforeSeq` (historial); sin ninguno, los últimos. En orden de `seq`.',
  })
  @ApiOkResponse({ type: InboxMessageListResponseDto })
  @ApiBadRequestResponse({
    description:
      'Id que no es uuid, `afterSeq` y `beforeSeq` juntos o `limit` fuera de 1–100',
  })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  async mensajes(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: MessagesQueryDto,
  ): Promise<InboxMessageListResponseDto> {
    const actor = this.acceso.deLaPersona(user, distributorId);
    const { items, hasMore } = await this.bandeja.mensajes(actor, id, query);
    return {
      items: await this.presentar.mensajes(items, lectorDe(actor)),
      hasMore,
    };
  }

  @Post(':id/messages')
  @ApiOperation({
    summary: 'Escribir en una conversación mía',
    description:
      '`replyToSeq` responde a un mensaje anterior de la misma conversación. Reintentar con el mismo `clientMessageId` devuelve el mensaje ya guardado (200). Fuera del horario de la empresa, al cliente le responde el sistema una vez por período cerrado.',
  })
  @ApiCreatedResponse({ type: InboxMessageDto })
  @ApiOkResponse({ type: InboxMessageDto, description: 'Reintento: ya estaba' })
  @ApiBadRequestResponse({
    description:
      'Texto vacío o de más de 2000, `replyToSeq` que no existe en la conversación (`REPLY_TO_INVALID`)',
  })
  @ApiForbiddenResponse({
    description:
      'La cuenta no es de un cliente o un chofer; la empresa apagó el chat con los clientes (`CUSTOMER_CHAT_DISABLED`)',
  })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  @ApiConflictResponse({
    description:
      'La conversación está cerrada (`CONVERSATION_CLOSED`): se abre otra con `POST /v2/me/conversations`',
  })
  @ApiTooManyRequestsResponse({ description: RAPIDO })
  async enviar(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendInboxMessageDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InboxMessageDto> {
    const actor = this.acceso.deLaPersona(user, distributorId);
    const r = await this.bandeja.enviar(actor, id, dto);
    res.status(r.created ? HttpStatus.CREATED : HttpStatus.OK);
    return this.presentar.mensaje(r.message, lectorDe(actor));
  }

  @Patch(':id/messages/:messageId')
  @ApiOperation({
    summary: 'Editar un mensaje mío',
    description:
      'Sólo texto propio, hasta 15 minutos después de enviarlo y con la conversación abierta. No se edita si la conversación es por un pedido, si el mensaje forma parte de un reclamo o de un ticket, o si ya respondieron citándolo (`canEdit` lo anticipa con la misma regla). Queda la marca `editedAt`; la empresa lo recibe en vivo.',
  })
  @ApiOkResponse({ type: InboxMessageDto })
  @ApiBadRequestResponse({
    description: 'Ids que no son uuid, texto vacío o de más de 2000',
  })
  @ApiForbiddenResponse({
    description:
      'La cuenta no es de un cliente o un chofer, o el mensaje es de la empresa (`MESSAGE_NOT_OWN`)',
  })
  @ApiNotFoundResponse({
    description: `${NO_EXISTE}; o el mensaje no es de esa conversación`,
  })
  @ApiConflictResponse({
    description:
      'Pasaron los 15 minutos (`MESSAGE_EDIT_WINDOW_CLOSED`), no es un texto (`MESSAGE_NOT_EDITABLE`), la conversación es por un pedido (`MESSAGE_IN_ORDER_CONVERSATION`), forma parte de un reclamo o un ticket (`MESSAGE_LINKED_TO_CLAIM`), ya lo citaron en una respuesta (`MESSAGE_ALREADY_QUOTED`) o la conversación está cerrada (`CONVERSATION_CLOSED`)',
  })
  async editar(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Body() dto: EditMessageDto,
  ): Promise<InboxMessageDto> {
    const actor = this.acceso.deLaPersona(user, distributorId);
    const m = await this.bandeja.editar(actor, id, messageId, dto.body);
    return this.presentar.mensaje(m, lectorDe(actor));
  }

  @Delete(':id/messages/:messageId')
  @ApiOperation({
    summary: 'Borrar un mensaje mío (sólo el cliente)',
    description:
      'D-C23: el cliente borra su texto en una conversación general con la empresa, hasta 15 minutos después de enviarlo. Queda en su lugar con `deleted: true` y sin texto, para las dos puntas (llega `chat:message-deleted`). No se borra si la conversación es por un pedido, si el mensaje forma parte de un reclamo o de un ticket, o si ya respondieron citándolo. Borrar otra vez devuelve lo mismo.',
  })
  @ApiOkResponse({
    type: InboxMessageDto,
    description: 'Borrado (o ya estaba borrado)',
  })
  @ApiBadRequestResponse({ description: 'Ids que no son uuid' })
  @ApiForbiddenResponse({
    description:
      'La cuenta no es de un cliente (un chofer: `MESSAGE_DELETE_NOT_ALLOWED`; el personal y la plataforma, por rol), o el mensaje es de otro (`MESSAGE_NOT_OWN`)',
  })
  @ApiNotFoundResponse({
    description: `${NO_EXISTE}; o el mensaje no es de esa conversación`,
  })
  @ApiConflictResponse({
    description:
      'Pasaron los 15 minutos (`MESSAGE_DELETE_WINDOW_CLOSED`), la conversación es por un pedido (`MESSAGE_IN_ORDER_CONVERSATION`), forma parte de un reclamo o un ticket (`MESSAGE_LINKED_TO_CLAIM`), ya lo citaron en una respuesta (`MESSAGE_ALREADY_QUOTED`), no es un texto (`MESSAGE_NOT_EDITABLE`) o la conversación está cerrada (`CONVERSATION_CLOSED`)',
  })
  async borrar(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ): Promise<InboxMessageDto> {
    const actor = this.acceso.deLaPersona(user, distributorId);
    const m = await this.bandeja.borrar(actor, id, messageId);
    return this.presentar.mensaje(m, lectorDe(actor));
  }

  @Post(':id/actions')
  @ApiOperation({
    summary: 'Tocar un botón de acción (cliente)',
    description:
      'Manda el mensaje predefinido de la acción como un mensaje del cliente (lo atiende el asistente o el equipo como siempre). `talk_to_person` además pasa la conversación a una persona (el asistente no contesta). Las de la app (`repeat_last_order`) no se mandan: 400. Reintentar con el mismo `clientMessageId` devuelve el mensaje ya guardado (200).',
  })
  @ApiCreatedResponse({ type: InboxMessageDto })
  @ApiOkResponse({ type: InboxMessageDto, description: 'Reintento: ya estaba' })
  @ApiBadRequestResponse({
    description:
      'Id que no es uuid, `key` desconocida o sin `clientMessageId`; la empresa no muestra esa acción (`ACTION_NOT_AVAILABLE`); la abre la app (`ACTION_IS_APP_ONLY`); el cliente sin `X-Distributor`',
  })
  @ApiForbiddenResponse({
    description:
      'La cuenta no es de un cliente o un chofer; el chofer (`CUSTOMER_ONLY`); la empresa apagó el chat con los clientes (`CUSTOMER_CHAT_DISABLED`); o no tiene habilitados los mensajes (`MODULE_DISABLED`)',
  })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  @ApiConflictResponse({
    description:
      'La conversación está cerrada (`CONVERSATION_CLOSED`) o ya no se puede escribir (`CHAT_NOT_WRITABLE`)',
  })
  @ApiTooManyRequestsResponse({ description: RAPIDO })
  async accion(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendCustomerActionDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InboxMessageDto> {
    const actor = this.acceso.deLaPersona(user, distributorId);
    const r = await this.bandeja.accion(actor, id, dto);
    res.status(r.created ? HttpStatus.CREATED : HttpStatus.OK);
    return this.presentar.mensaje(r.message, lectorDe(actor));
  }

  @Post(':id/rating')
  @ApiOperation({
    summary: 'Calificar la conversación (cliente)',
    description:
      'La respuesta a ESA encuesta (`ratingId` del `payload` de su mensaje `csat_request`; cada cierre tiene la suya): 1 a 5 y un comentario opcional. Una sola vez, con la conversación cerrada y hasta 48 h después del cierre; si la empresa la reabrió, esa encuesta quedó anulada. Reintentar con la misma respuesta devuelve la guardada (200). Si en vez de calificar el cliente escribe, abre otra conversación como siempre. Al cliente no le llega `servedBy`.',
  })
  @ApiCreatedResponse({ type: ConversationRatingResponseDto })
  @ApiOkResponse({
    type: ConversationRatingResponseDto,
    description: 'Reintento con la misma respuesta: ya estaba',
  })
  @ApiBadRequestResponse({
    description:
      'Id que no es uuid, falta `ratingId` o no es uuid, `score` fuera de 1–5 o no entero, comentario vacío o de más de 280; el cliente sin `X-Distributor`',
  })
  @ApiForbiddenResponse({
    description:
      'La cuenta no es de un cliente o un chofer; el chofer (`CUSTOMER_ONLY`); o la empresa no tiene habilitados los mensajes (`MODULE_DISABLED`)',
  })
  @ApiNotFoundResponse({
    description: `${NO_EXISTE}; o esa encuesta no es de esta conversación o de quien pide (\`RATING_NOT_FOUND\`)`,
  })
  @ApiConflictResponse({
    description:
      'Ya la calificó con otra respuesta (`RATING_ALREADY_ANSWERED`), se anuló porque la conversación se reabrió o está abierta (`RATING_CANCELLED`), o venció (`RATING_EXPIRED`)',
  })
  async calificar(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RateConversationDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConversationRatingResponseDto> {
    const actor = this.acceso.deLaPersona(user, distributorId);
    const r = await this.encuesta.responder(actor, id, dto);
    res.status(r.created ? HttpStatus.CREATED : HttpStatus.OK);
    return {
      conversationId: r.rating.conversationId,
      ...encuestaADto(r.rating, new Date(), false),
    };
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Marcar leído hasta un mensaje',
    description: 'La empresa lo ve como «leído». Nunca baja.',
  })
  @ApiNoContentResponse({ description: 'Listo' })
  @ApiBadRequestResponse({ description: 'Id que no es uuid o número negativo' })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  async leer(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReadUpToDto,
  ): Promise<void> {
    const actor = this.acceso.deLaPersona(user, distributorId);
    await this.bandeja.leer(actor, id, dto.seq);
  }
}
