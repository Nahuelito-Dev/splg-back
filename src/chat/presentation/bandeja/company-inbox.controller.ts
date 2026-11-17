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
  Put,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
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
import { Permiso } from '../../../common/decorators/permiso.decorator';
import { RequiereModulo } from '../../../platform/access/requiere-modulo.decorator';
import { BandejaAcceso, lectorDe } from '../../application/bandeja-acceso';
import { BandejaEquipoService } from '../../application/bandeja-equipo.service';
import { BandejaGestionService } from '../../application/bandeja-gestion.service';
import { BandejaNotasService } from '../../application/bandeja-notas.service';
import { BandejaEncuestaService } from '../../application/bandeja-encuesta.service';
import { BandejaSugerenciasService } from '../../application/bandeja-sugerencias.service';
import { BandejaService } from '../../application/bandeja.service';
import { ChatLabelsService } from '../../application/chat-labels.service';
import { TiempoEsperadoService } from '../../application/tiempo-esperado.service';
import type { CanalDeLaBandeja } from '../../domain/bandeja';
import { tiempoEsperadoADto } from '../tiempo-esperado.mapper';
import { BandejaPresenter } from '../bandeja.presenter';
import {
  AssignConversationDto,
  BroadcastDriversDto,
  CreateClaimFromConversationDto,
  EditMessageDto,
  MarkMentionsReadDto,
  OpenStaffConversationDto,
  QueryCsatDto,
  QueryInboxDto,
  SendInternalNoteDto,
  SendStaffMessageDto,
  SetConversationLabelsDto,
} from '../dto/bandeja-input.dto';
import {
  BroadcastResponseDto,
  CsatSummaryResponseDto,
  ClaimFromConversationResponseDto,
  InboxAssigneeListResponseDto,
  InboxConversationDto,
  InboxListResponseDto,
  InboxMessageDto,
  InboxMessageListResponseDto,
  InboxSuggestionsResponseDto,
  InboxSummaryDto,
  MentionsReadResponseDto,
  OpenConversationResponseDto,
} from '../dto/bandeja-response.dto';
import { MessagesQueryDto, ReadUpToDto } from '../dto/chat-input.dto';

const NO_EXISTE =
  'No existe, es de otra empresa o de un canal que quien pide no atiende';
const SIN_CANAL =
  'El rol de personal no atiende ese canal (`PERMISSION_DENIED`: los clientes piden `mensajes.clientes`, los choferes `mensajes.choferes`)';
const SIN_CANAL_NI_MODULO =
  'La cuenta no es del personal de una empresa; el rol no atiende ningún canal de mensajes (`PERMISSION_DENIED`); o la empresa no tiene habilitados los mensajes (`MODULE_DISABLED`)';

/**
 * Bandeja de la empresa (C3 clientes y C2 choferes, diseño §14.3). Del
 * personal de la empresa del perfil: cada uno ve y atiende sólo los canales de
 * su rol (`mensajes.clientes`, `mensajes.choferes`). Una conversación de otra
 * empresa o de un canal que no atiende es 404. Módulo `chat`.
 */
@ApiTags('Inbox (company)')
@RequiereModulo('chat')
@Permiso('mensajes.clientes', 'mensajes.choferes')
@Auth(RoleType.ADMIN)
@Controller({ path: 'conversations', version: '2' })
export class CompanyInboxController {
  constructor(
    private readonly acceso: BandejaAcceso,
    private readonly bandeja: BandejaService,
    private readonly gestion: BandejaGestionService,
    private readonly presentar: BandejaPresenter,
    private readonly sugerencias: BandejaSugerenciasService,
    private readonly equipo: BandejaEquipoService,
    private readonly notas: BandejaNotasService,
    private readonly encuesta: BandejaEncuestaService,
    private readonly etiquetas: ChatLabelsService,
    private readonly esperado: TiempoEsperadoService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'La bandeja: conversaciones con clientes y choferes',
    description:
      'Sólo los canales que atiende quien pide. Ordenadas por el último mensaje; con `assigned=none`, primero las que esperan a una persona (el asistente con IA las derivó; la que espera hace más, primero). `awaiting=true` deja sólo las que esperan. `mentioned=me` es la vista «Me mencionaron» (con alguna nota que menciona a quien pide; `mentioned=unread`, sólo con menciones sin leer). `counts` son las abiertas de esos canales: sin asignar, asignadas a quien pide y todas.',
  })
  @ApiOkResponse({ type: InboxListResponseDto })
  @ApiBadRequestResponse({
    description:
      'Filtro inválido: canal, estado, `assigned` (`me`, `none` o uuid), ids, `awaiting` que no es `true`/`false`, `mentioned` que no es `me`/`unread`, `q` de menos de 3 caracteres, fecha o paginación',
  })
  @ApiForbiddenResponse({ description: SIN_CANAL })
  async listar(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Query() query: QueryInboxDto,
  ): Promise<InboxListResponseDto> {
    const actor = await this.acceso.delPersonal(user, distributorId);
    const { items, total, counts } = await this.gestion.listar(actor, query);
    return {
      items: await this.presentar.conversaciones(items, lectorDe(actor)),
      total,
      counts,
    };
  }

  @Post()
  @ApiOperation({
    summary: 'Escribirle a un cliente o a un chofer',
    description:
      'General (con `customerId` o `driverId`) o por un pedido (`orderId`: el cliente o el chofer salen del pedido). Si ya hay una abierta del mismo tema, se agrega el mensaje (200); si no, se crea (201). El mismo `clientMessageId` repetido devuelve el mensaje ya guardado (200).',
  })
  @ApiCreatedResponse({ type: OpenConversationResponseDto })
  @ApiOkResponse({
    type: OpenConversationResponseDto,
    description: 'Ya había una abierta del mismo tema, o es un reintento',
  })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos: canal, ámbito, falta el cliente o el chofer, pedido en una general, texto vacío o de más de 2000, `body` y `templateId` juntos, `replyToSeq` que no existe (`REPLY_TO_INVALID`)',
  })
  @ApiForbiddenResponse({
    description: `${SIN_CANAL}; o la empresa apagó el chat con los clientes (\`CUSTOMER_CHAT_DISABLED\`)`,
  })
  @ApiNotFoundResponse({
    description:
      'El cliente, el chofer, el pedido o la respuesta guardada no existen o son de otra empresa',
  })
  @ApiConflictResponse({
    description:
      'Pasaron 30 días desde que el pedido se entregó o se canceló (`ORDER_CHAT_WINDOW_CLOSED`), o el pedido no tiene chofer (`ORDER_WITHOUT_DRIVER`)',
  })
  @ApiTooManyRequestsResponse({
    description: 'Más de 30 mensajes por minuto (`CHAT_RATE_LIMITED`)',
  })
  async abrir(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Body() dto: OpenStaffConversationDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OpenConversationResponseDto> {
    const actor = await this.acceso.delPersonal(user, distributorId);
    const r = await this.bandeja.abrirDelPersonal(actor, dto);
    res.status(r.conversationCreated ? HttpStatus.CREATED : HttpStatus.OK);
    const lector = lectorDe(actor);
    return {
      conversation: await this.presentar.conversacion(r.conversation, lector),
      message: await this.presentar.mensaje(r.message, lector),
    };
  }

  @Post('broadcast-drivers')
  @HttpCode(HttpStatus.ACCEPTED)
  @Permiso('mensajes.choferes')
  @ApiOperation({
    summary: 'Un mismo mensaje a varios choferes',
    description:
      'Uno en la conversación general de cada chofer (la abierta o una nueva): nadie ve las respuestas de los otros. Hasta 50. Repetir el `clientBatchId` no duplica.',
  })
  @ApiAcceptedResponse({ type: BroadcastResponseDto })
  @ApiBadRequestResponse({
    description:
      'Lista vacía, de más de 50, con repetidos o ids que no son uuid; texto vacío o de más de 2000',
  })
  @ApiNotFoundResponse({
    description:
      'Alguno de los choferes no es de la empresa: no se manda a ninguno',
  })
  @ApiTooManyRequestsResponse({
    description: 'Más de 30 envíos por minuto (`CHAT_RATE_LIMITED`)',
  })
  async difundir(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Body() dto: BroadcastDriversDto,
  ): Promise<BroadcastResponseDto> {
    const actor = await this.acceso.delPersonal(user, distributorId);
    return this.gestion.difundir(actor, dto);
  }

  @Get('summary')
  @ApiOperation({
    summary: 'Resumen de la bandeja (insignias)',
    description:
      'Para la insignia del menú «Mensajes» y las pestañas: de las conversaciones abiertas de los canales que atiende quien pide (`mensajes.clientes`, `mensajes.choferes`), cuántas están sin asignar, cuántas son suyas, cuántas esperan a una persona, cuántas tienen algo sin leer para quien pide (sin las asignadas a otra persona), cuántas piden atención (sin asignar ∪ esperando persona ∪ sin leer, sin duplicar) y cuántas menciones sin leer tiene en notas internas. Sólo de su empresa.',
  })
  @ApiOkResponse({ type: InboxSummaryDto })
  @ApiForbiddenResponse({ description: SIN_CANAL_NI_MODULO })
  async resumen(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
  ): Promise<InboxSummaryDto> {
    const actor = await this.acceso.delPersonal(user, distributorId);
    return this.equipo.resumen(actor);
  }

  @Get('csat')
  @Permiso('mensajes.clientes')
  @ApiOperation({
    summary: 'Resumen de la encuesta de satisfacción',
    description:
      'De las encuestas pedidas al cerrar conversaciones con clientes en el período (por cuándo se pidieron; sin `from`, los últimos 30 días): pedidas, respondidas, vencidas, promedio (1 a 5), CSAT (proporción de 4 y 5) y lo mismo de las atendidas sólo por el asistente con IA y de las atendidas por el equipo. Sólo de la empresa de quien pide. Es lo que lee el tablero (B4).',
  })
  @ApiOkResponse({ type: CsatSummaryResponseDto })
  @ApiBadRequestResponse({ description: 'Fecha inválida' })
  @ApiForbiddenResponse({
    description:
      'Sin `mensajes.clientes` (`PERMISSION_DENIED`), la cuenta no es del personal o la empresa no tiene habilitados los mensajes (`MODULE_DISABLED`)',
  })
  async csat(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Query() query: QueryCsatDto,
  ): Promise<CsatSummaryResponseDto> {
    const actor = await this.acceso.delPersonal(user, distributorId);
    const r = await this.encuesta.resumen(actor, query);
    return { ...r, from: r.from.toISOString(), to: r.to.toISOString() };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Una conversación de la bandeja',
    description:
      'Con sus etiquetas y el tiempo de respuesta esperado que ve hoy el cliente o el chofer de ese canal (`expectedReply`).',
  })
  @ApiOkResponse({ type: InboxConversationDto })
  @ApiBadRequestResponse({ description: 'Id que no es uuid' })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  async una(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InboxConversationDto> {
    const actor = await this.acceso.delPersonal(user, distributorId);
    const c = await this.bandeja.conversacion(actor, id);
    const [dto, esperado] = await Promise.all([
      this.presentar.conversacion(c, lectorDe(actor)),
      this.esperado.delCanal(distributorId, c.channel as CanalDeLaBandeja),
    ]);
    return { ...dto, expectedReply: tiempoEsperadoADto(esperado) };
  }

  @Get(':id/suggestions')
  @ApiOperation({
    summary: 'Sugerencias de respuesta',
    description:
      'Hasta 3 respuestas guardadas de la empresa (activas y de este canal) parecidas al último mensaje del cliente o del chofer, sin IA: búsqueda de texto en castellano, sin tildes. Con las variables ya completadas para esta conversación. No manda nada: el panel las ofrece para pegar y editar. Lista vacía si nada se parece o si la persona todavía no escribió.',
  })
  @ApiOkResponse({ type: InboxSuggestionsResponseDto })
  @ApiBadRequestResponse({ description: 'Id que no es uuid' })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  async sugerir(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InboxSuggestionsResponseDto> {
    const actor = await this.acceso.delPersonal(user, distributorId);
    const r = await this.sugerencias.sugerir(actor, id);
    return { basedOnSeq: r.basadoEnSeq, items: r.items };
  }

  @Get(':id/assignees')
  @ApiOperation({
    summary: 'A quién se le puede asignar',
    description:
      'El personal vigente de la empresa (sin baja ni bloqueo, con un rol vigente) que atiende el canal de la conversación: `mensajes.clientes` para las de clientes, `mensajes.choferes` para las de choferes (un rol de sistema atiende los dos). Es la misma regla con que `assign` valida. Ordenado por nombre; nadie de otra empresa.',
  })
  @ApiOkResponse({ type: InboxAssigneeListResponseDto })
  @ApiBadRequestResponse({ description: 'Id que no es uuid (`INVALID_ID`)' })
  @ApiForbiddenResponse({ description: SIN_CANAL_NI_MODULO })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  async personasParaAsignar(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InboxAssigneeListResponseDto> {
    const actor = await this.acceso.delPersonal(user, distributorId);
    return { items: await this.equipo.paraAsignar(actor, id) };
  }

  @Get(':id/messages')
  @ApiOperation({
    summary: 'Mensajes de una conversación',
    description:
      'Por número: `afterSeq` (los posteriores, para reconectar) o `beforeSeq` (los anteriores); sin ninguno, los últimos. Siempre en orden de `seq`.',
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
    const actor = await this.acceso.delPersonal(user, distributorId);
    const { items, hasMore } = await this.bandeja.mensajes(actor, id, query);
    return {
      items: await this.presentar.mensajes(items, lectorDe(actor)),
      hasMore,
    };
  }

  @Post(':id/messages')
  @ApiOperation({
    summary: 'Responder',
    description:
      'Texto o una respuesta guardada (`templateId`, el back completa sus variables). `replyToSeq` responde a un mensaje anterior de la misma conversación. Reintentar con el mismo `clientMessageId` devuelve el mensaje ya guardado (200).',
  })
  @ApiCreatedResponse({ type: InboxMessageDto })
  @ApiOkResponse({ type: InboxMessageDto, description: 'Reintento: ya estaba' })
  @ApiBadRequestResponse({
    description:
      'Texto vacío o de más de 2000, `body` y `templateId` juntos o ninguno, `replyToSeq` que no existe en la conversación (`REPLY_TO_INVALID`)',
  })
  @ApiNotFoundResponse({
    description: `${NO_EXISTE}; o la respuesta guardada no existe, está inactiva o es de otro canal`,
  })
  @ApiConflictResponse({
    description: 'La conversación está cerrada (`CONVERSATION_CLOSED`)',
  })
  @ApiTooManyRequestsResponse({
    description: 'Más de 30 mensajes por minuto (`CHAT_RATE_LIMITED`)',
  })
  async enviar(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendStaffMessageDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InboxMessageDto> {
    const actor = await this.acceso.delPersonal(user, distributorId);
    const r = await this.bandeja.enviar(actor, id, dto);
    res.status(r.created ? HttpStatus.CREATED : HttpStatus.OK);
    return this.presentar.mensaje(r.message, lectorDe(actor));
  }

  @Post(':id/notes')
  @ApiOperation({
    summary: 'Dejar una nota interna (con @menciones)',
    description:
      'Sólo la ve el personal de la empresa: nunca le llega al cliente ni al chofer (ni por HTTP ni por el socket), ni al asistente con IA. No cuenta como primera respuesta, no saca a la conversación de «esperando persona» ni cambia su vista previa. `mentions` avisa a cada persona mencionada (aviso del panel sólo para ella) y la nota queda en su «Me mencionaron» hasta que la lee. Se edita como un mensaje propio (`PATCH :id/messages/:messageId`, sólo su autor, 15 minutos). Reintentar con el mismo `clientMessageId` devuelve la nota ya guardada (200) sin volver a avisar.',
  })
  @ApiCreatedResponse({ type: InboxMessageDto })
  @ApiOkResponse({ type: InboxMessageDto, description: 'Reintento: ya estaba' })
  @ApiBadRequestResponse({
    description:
      'Id que no es uuid, texto vacío o de más de 2000, `mentions` que no es una lista de uuid sin repetir de hasta 10, o menciona a alguien que no atiende este canal (`MENTION_NOT_ALLOWED`)',
  })
  @ApiForbiddenResponse({ description: SIN_CANAL_NI_MODULO })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  @ApiConflictResponse({
    description: 'La conversación está cerrada (`CONVERSATION_CLOSED`)',
  })
  @ApiTooManyRequestsResponse({
    description: 'Más de 30 mensajes por minuto (`CHAT_RATE_LIMITED`)',
  })
  async nota(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendInternalNoteDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InboxMessageDto> {
    const actor = await this.acceso.delPersonal(user, distributorId);
    const r = await this.notas.escribir(actor, id, dto);
    res.status(r.created ? HttpStatus.CREATED : HttpStatus.OK);
    return this.presentar.mensaje(r.message, lectorDe(actor));
  }

  @Post(':id/mentions/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Marcar leídas mis menciones en la conversación',
    description:
      'Las menciones a quien pide en las notas internas de la conversación (todas, o hasta la nota `upToSeq`). Leer la conversación (`POST :id/read`) también las marca hasta ese mensaje. Idempotente: las ya leídas no cuentan.',
  })
  @ApiOkResponse({ type: MentionsReadResponseDto })
  @ApiBadRequestResponse({
    description: 'Id que no es uuid o `upToSeq` que no es un entero positivo',
  })
  @ApiForbiddenResponse({ description: SIN_CANAL_NI_MODULO })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  async leerMenciones(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkMentionsReadDto,
  ): Promise<MentionsReadResponseDto> {
    const actor = await this.acceso.delPersonal(user, distributorId);
    return { updated: await this.notas.marcarLeidas(actor, id, dto.upToSeq) };
  }

  @Patch(':id/messages/:messageId')
  @ApiOperation({
    summary: 'Editar un mensaje propio',
    description:
      'Sólo quien lo escribió (no un compañero), sólo texto y hasta 15 minutos después de enviarlo, con la conversación abierta. No se edita lo que quedó como constancia: una conversación por un pedido, un mensaje que forma parte de un reclamo o un ticket, o uno que ya citaron (`canEdit` lo anticipa con la misma regla). Queda la marca `editedAt` y el texto anterior en el historial. La otra punta lo recibe por el socket (`chat:message-edited`).',
  })
  @ApiOkResponse({ type: InboxMessageDto })
  @ApiBadRequestResponse({
    description: 'Ids que no son uuid, texto vacío o de más de 2000',
  })
  @ApiForbiddenResponse({
    description: 'El mensaje lo escribió otra persona (`MESSAGE_NOT_OWN`)',
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
    const actor = await this.acceso.delPersonal(user, distributorId);
    const m = await this.bandeja.editar(actor, id, messageId, dto.body);
    return this.presentar.mensaje(m, lectorDe(actor));
  }

  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Asignar (o devolver a la cola)',
    description:
      'A alguien del personal de la empresa que atienda el canal; `userId: null` la devuelve a la cola. Tomarla es asignársela a uno mismo.',
  })
  @ApiOkResponse({ type: InboxConversationDto })
  @ApiBadRequestResponse({
    description:
      'Id que no es uuid, o esa persona no atiende este canal (`ASSIGNEE_WITHOUT_PERMISSION`)',
  })
  @ApiNotFoundResponse({
    description: `${NO_EXISTE}; o la persona no es del personal de la empresa`,
  })
  @ApiConflictResponse({
    description: 'La conversación está cerrada (`CONVERSATION_CLOSED`)',
  })
  async asignar(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignConversationDto,
  ): Promise<InboxConversationDto> {
    const actor = await this.acceso.delPersonal(user, distributorId);
    const c = await this.gestion.asignar(actor, id, dto.userId);
    return this.presentar.conversacion(c, lectorDe(actor));
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cerrar',
    description:
      'Queda en lectura. El cliente o el chofer que vuelva a escribir abre otra; la empresa la puede reabrir. Con un cliente, si la empresa tiene prendida la encuesta, sale el mensaje `csat_request` para que califique (1 a 5, hasta 48 h).',
  })
  @ApiOkResponse({ type: InboxConversationDto })
  @ApiBadRequestResponse({ description: 'Id que no es uuid' })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  @ApiConflictResponse({
    description: 'Ya estaba cerrada (`CONVERSATION_CLOSED`)',
  })
  async cerrar(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InboxConversationDto> {
    const actor = await this.acceso.delPersonal(user, distributorId);
    const c = await this.gestion.cerrar(actor, id);
    return this.presentar.conversacion(c, lectorDe(actor));
  }

  @Post(':id/reopen')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reabrir',
    description: 'Una abierta queda igual.',
  })
  @ApiOkResponse({ type: InboxConversationDto })
  @ApiBadRequestResponse({ description: 'Id que no es uuid' })
  @ApiNotFoundResponse({ description: NO_EXISTE })
  @ApiConflictResponse({
    description:
      'Ya hay otra abierta del mismo tema: la general de esa persona o la de ese pedido (`CONVERSATION_NOT_REOPENABLE`)',
  })
  async reabrir(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InboxConversationDto> {
    const actor = await this.acceso.delPersonal(user, distributorId);
    const c = await this.gestion.reabrir(actor, id);
    return this.presentar.conversacion(c, lectorDe(actor));
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Marcar leído hasta un mensaje',
    description:
      'La lectura es de cada persona; el cliente o el chofer ven como «leído» lo máximo que leyó alguien de la empresa. Nunca baja.',
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
    const actor = await this.acceso.delPersonal(user, distributorId);
    await this.bandeja.leer(actor, id, dto.seq);
  }

  @Put(':id/labels')
  @ApiOperation({
    summary: 'Poner o sacar etiquetas',
    description:
      'Deja en la conversación exactamente las etiquetas de `labelIds` (hasta 5; vacía: le saca todas). También en una cerrada. Con los permisos del canal. Mandar las mismas no cambia nada. Queda en la auditoría y la bandeja recibe `chat:inbox` con `change: labels` y las etiquetas (sólo el panel: el cliente y el chofer no se enteran).',
  })
  @ApiOkResponse({ type: InboxConversationDto })
  @ApiBadRequestResponse({
    description:
      'Id que no es uuid, falta `labelIds` o no es una lista, más de 5, repetidas o ids que no son uuid',
  })
  @ApiForbiddenResponse({ description: SIN_CANAL_NI_MODULO })
  @ApiNotFoundResponse({
    description: `${NO_EXISTE}; o alguna etiqueta no existe, está dada de baja o es de otra empresa (\`CHAT_LABEL_NOT_FOUND\`)`,
  })
  async etiquetar(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetConversationLabelsDto,
  ): Promise<InboxConversationDto> {
    const actor = await this.acceso.delPersonal(user, distributorId);
    const c = await this.etiquetas.ponerEnConversacion(actor, id, dto.labelIds);
    return this.presentar.conversacion(c, lectorDe(actor));
  }

  @Post(':id/claim')
  @Permiso('mensajes.clientes')
  @ApiOperation({
    summary: 'Crear un reclamo desde la conversación',
    description:
      'Sólo en una conversación abierta con un cliente y con `reclamos.gestionar`. El reclamo (que sigue su propia máquina), el vínculo (`linkedClaimId`) y el mensaje de sistema `claim_created` se guardan juntos o nada. En una por pedido, el reclamo va por ese pedido. Repetir el mismo reclamo devuelve el ya creado (200).',
  })
  @ApiCreatedResponse({ type: ClaimFromConversationResponseDto })
  @ApiOkResponse({
    type: ClaimFromConversationResponseDto,
    description: 'Reintento: el mismo reclamo ya estaba creado',
  })
  @ApiBadRequestResponse({
    description:
      'Id que no es uuid, motivo o descripción vacíos o largos, falta el pedido en una general, pedido distinto del de la conversación o de otro cliente',
  })
  @ApiForbiddenResponse({
    description:
      'Sin `reclamos.gestionar` (`PERMISSION_DENIED`) o sin `mensajes.clientes`',
  })
  @ApiNotFoundResponse({
    description: `${NO_EXISTE} (una con un chofer tampoco); o el pedido no es de la empresa`,
  })
  @ApiConflictResponse({
    description:
      'La conversación ya tiene otro reclamo (`CONVERSATION_ALREADY_HAS_CLAIM`) o está cerrada (`CONVERSATION_CLOSED`)',
  })
  async reclamo(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentDistributor({ required: true }) distributorId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateClaimFromConversationDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ClaimFromConversationResponseDto> {
    const actor = await this.acceso.delPersonal(user, distributorId);
    const r = await this.gestion.crearReclamo(actor, id, dto);
    res.status(r.created ? HttpStatus.CREATED : HttpStatus.OK);
    return {
      claimId: r.claimId,
      conversation: await this.presentar.conversacion(
        r.conversation,
        lectorDe(actor),
      ),
    };
  }
}
