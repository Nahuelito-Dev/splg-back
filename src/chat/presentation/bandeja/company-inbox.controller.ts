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
import { BandejaGestionService } from '../../application/bandeja-gestion.service';
import { BandejaSugerenciasService } from '../../application/bandeja-sugerencias.service';
import { BandejaService } from '../../application/bandeja.service';
import { BandejaPresenter } from '../bandeja.presenter';
import {
  AssignConversationDto,
  BroadcastDriversDto,
  CreateClaimFromConversationDto,
  EditMessageDto,
  OpenStaffConversationDto,
  QueryInboxDto,
  SendStaffMessageDto,
} from '../dto/bandeja-input.dto';
import {
  BroadcastResponseDto,
  ClaimFromConversationResponseDto,
  InboxConversationDto,
  InboxListResponseDto,
  InboxMessageDto,
  InboxMessageListResponseDto,
  InboxSuggestionsResponseDto,
  OpenConversationResponseDto,
} from '../dto/bandeja-response.dto';
import { MessagesQueryDto, ReadUpToDto } from '../dto/chat-input.dto';

const NO_EXISTE =
  'No existe, es de otra empresa o de un canal que quien pide no atiende';
const SIN_CANAL =
  'El rol de personal no atiende ese canal (`PERMISSION_DENIED`: los clientes piden `mensajes.clientes`, los choferes `mensajes.choferes`)';

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
  ) {}

  @Get()
  @ApiOperation({
    summary: 'La bandeja: conversaciones con clientes y choferes',
    description:
      'Sólo los canales que atiende quien pide. Ordenadas por el último mensaje. `counts` son las abiertas de esos canales: sin asignar, asignadas a quien pide y todas.',
  })
  @ApiOkResponse({ type: InboxListResponseDto })
  @ApiBadRequestResponse({
    description:
      'Filtro inválido: canal, estado, `assigned` (`me`, `none` o uuid), ids, `q` de menos de 3 caracteres, fecha o paginación',
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

  @Get(':id')
  @ApiOperation({ summary: 'Una conversación de la bandeja' })
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
    return this.presentar.conversacion(c, lectorDe(actor));
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

  @Patch(':id/messages/:messageId')
  @ApiOperation({
    summary: 'Editar un mensaje propio',
    description:
      'Sólo quien lo escribió (no un compañero), sólo texto y hasta 15 minutos después de enviarlo, con la conversación abierta. Queda la marca `editedAt` y el texto anterior en el historial. La otra punta lo recibe por el socket (`chat:message-edited`).',
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
      'Pasaron los 15 minutos (`MESSAGE_EDIT_WINDOW_CLOSED`), no es un texto (`MESSAGE_NOT_EDITABLE`) o la conversación está cerrada (`CONVERSATION_CLOSED`)',
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
      'Queda en lectura. El cliente o el chofer que vuelva a escribir abre otra; la empresa la puede reabrir.',
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
