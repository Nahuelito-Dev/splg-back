import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Channel,
  ConversationClosedReason,
  ConversationStatus,
  MessageKind,
  Party,
  SubjectType,
  SystemCode,
} from '../../domain/chat.enums';
import { CLAVES_DE_ACCION } from '../../domain/acciones-del-cliente';
import { COLORES_DE_ETIQUETA } from '../../domain/etiquetas';
import { ChatHoursDto } from './support-settings.dto';
import { ChatAttachmentDto } from './chat-attachment.dto';

const CANALES = [Channel.STAFF_CUSTOMER, Channel.STAFF_DRIVER];

/** La otra punta, como la ve quien pide: el cliente y el chofer ven la empresa, nunca al operador (D-C5). */
export class InboxCounterpartDto {
  @ApiProperty({ enum: Party }) party!: Party;
  @ApiProperty({
    example: 'Gas Norte',
    description:
      'Para el cliente y el chofer, el nombre de la empresa como la conocen (el de su marca si lo cargó; si no, el legal); para el personal, el del cliente o el chofer',
  })
  displayName!: string;
}

export class InboxOrderDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'A1B2C3', description: 'Número corto del pedido' })
  number!: string;
  @ApiProperty({ example: 'on_the_way' }) status!: string;
}

export class InboxPersonDto {
  @ApiProperty({ format: 'uuid', description: 'Usuario' }) id!: string;
  @ApiProperty() displayName!: string;
}

export class InboxAssigneeDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() fullName!: string;
}

export class InboxLastMessageDto {
  @ApiProperty() seq!: number;
  @ApiProperty({ type: String, nullable: true }) preview!: string | null;
  @ApiProperty({ format: 'date-time' }) at!: string;
  @ApiProperty({ enum: Party }) party!: Party;
}

/** Un botón de acción del chat para el cliente (4e). */
export class InboxActionDto {
  @ApiProperty({ enum: CLAVES_DE_ACCION, example: 'where_is_my_order' })
  key!: string;
  @ApiProperty({ example: '¿Dónde está mi pedido?' }) label!: string;
  @ApiProperty({
    enum: ['message', 'handoff', 'app'],
    description:
      '`message`: con un toque la app llama a `POST /v2/me/conversations/:id/actions` (manda el mensaje predefinido); `handoff`: igual, y la conversación pasa a una persona; `app`: la abre la app (p. ej. repetir el último pedido arma el pedido en su pantalla), el chat no la ejecuta',
  })
  kind!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: '¿Dónde está mi pedido?',
    description:
      'El mensaje que se manda al tocarlo (la app lo puede mostrar como burbuja enviada); `null` en las de la app',
  })
  text!: string | null;
}

export class CustomerActionListResponseDto {
  @ApiProperty({
    type: [InboxActionDto],
    description:
      'Las que muestra la empresa, en el orden del catálogo; vacía si no muestra ninguna o si no atiende por chat',
  })
  items!: InboxActionDto[];
}

/** La encuesta de satisfacción de un cierre (4b). */
export class InboxCsatDto {
  @ApiProperty({ format: 'uuid' }) ratingId!: string;
  @ApiProperty({
    enum: ['pending', 'answered', 'expired', 'cancelled'],
    description:
      'Pendiente (se puede responder), respondida, vencida (48 h) o anulada (la conversación se reabrió antes de que la respondieran)',
  })
  status!: 'pending' | 'answered' | 'expired' | 'cancelled';
  @ApiProperty({ type: Number, nullable: true, minimum: 1, maximum: 5 })
  score!: number | null;
  @ApiProperty({ type: String, nullable: true }) comment!: string | null;
  @ApiPropertyOptional({
    enum: ['assistant', 'team', 'none'],
    description:
      'Sólo para el personal: quién atendió el tramo calificado (desde la apertura o la reapertura): el equipo (alguien escribió), el asistente con IA (sólo él) o nadie',
  })
  servedBy?: 'assistant' | 'team' | 'none';
  @ApiProperty({ format: 'date-time' }) requestedAt!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  answeredAt!: string | null;
}

export class ConversationRatingResponseDto extends InboxCsatDto {
  @ApiProperty({ format: 'uuid' }) conversationId!: string;
}

export class CsatGroupDto {
  @ApiProperty({ description: 'Encuestas respondidas' }) answered!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 4.5,
    description: 'Promedio de 1 a 5; `null` sin respuestas',
  })
  average!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 0.8,
    description: 'CSAT: proporción de 4 y 5 sobre las respondidas (0 a 1)',
  })
  csat!: number | null;
}

/** Resumen de la encuesta en un período (4b): lo que lee el tablero (B4). */
export class CsatSummaryResponseDto {
  @ApiProperty({ format: 'date-time' }) from!: string;
  @ApiProperty({ format: 'date-time' }) to!: string;
  @ApiProperty({
    description: 'Encuestas pedidas (cierres con encuesta), sin las anuladas',
  })
  requested!: number;
  @ApiProperty() answered!: number;
  @ApiProperty({ description: 'Vencidas sin responder (sin las anuladas)' })
  expired!: number;
  @ApiProperty({
    description:
      'Anuladas: la conversación se reabrió antes de que las respondieran. No cuentan como pedidas ni como vencidas',
  })
  cancelled!: number;
  @ApiProperty({ type: Number, nullable: true }) average!: number | null;
  @ApiProperty({ type: Number, nullable: true }) csat!: number | null;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { '1': 0, '2': 1, '3': 2, '4': 5, '5': 12 },
    description: 'Cantidad de respuestas por puntaje',
  })
  byScore!: Record<string, number>;
  @ApiProperty({
    type: CsatGroupDto,
    description: 'Atendidas sólo por el asistente con IA',
  })
  assistant!: CsatGroupDto;
  @ApiProperty({ type: CsatGroupDto, description: 'Atendidas por el equipo' })
  team!: CsatGroupDto;
}

/** Una conversación de la bandeja (C3 con un cliente, C2 con un chofer). */
/** Una etiqueta de la bandeja (7c), como la ve el personal en cada conversación. */
export class InboxLabelDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Reclamo de envío', maxLength: 30 }) name!: string;
  @ApiProperty({ enum: COLORES_DE_ETIQUETA, example: 'orange' })
  color!: string;
}

/** Una etiqueta de la empresa (ABM). */
export class ChatLabelResponseDto extends InboxLabelDto {
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class ChatLabelListResponseDto {
  @ApiProperty({
    type: [ChatLabelResponseDto],
    description: 'Las vigentes, por nombre (hasta 50)',
  })
  items!: ChatLabelResponseDto[];
}

/** El tiempo de respuesta esperado (7c): lo que ve el cliente o el chofer antes de escribir. */
export class ExpectedReplyResponseDto {
  @ApiProperty({
    description:
      'La empresa lo muestra (si no, los demás campos vienen vacíos y la app no muestra nada)',
  })
  enabled!: boolean;
  @ApiProperty({ description: 'La empresa atiende ahora' }) openNow!: boolean;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 15,
    description:
      'Minutos que se prometen, redondeados para mostrar (en horario); `null` fuera de horario o apagado',
  })
  minutes!: number | null;
  @ApiProperty({
    enum: ['history', 'target', 'waiting'],
    nullable: true,
    description:
      '`history`: mediana, en minutos hábiles, de la primera respuesta de las conversaciones del canal de los últimos 14 días junto con lo que llevan esperando las que esperan ahora (con 10 o más entre las dos); `target`: el objetivo de la empresa (con menos); `waiting`: con menos, pero las que esperan ya llevan más que el objetivo (se muestra lo que llevan)',
  })
  basis!: 'history' | 'target' | 'waiting' | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Fuera de horario: cuándo vuelve a atender',
  })
  nextOpenAt!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Solemos responder en ~15 min',
    description:
      'Listo para mostrar: «Solemos responder en ~N min» (o «~N h») en horario, «Ahora estamos fuera de horario. Te respondemos mañana a las 08:00.» fuera; `null` si está apagado',
  })
  text!: string | null;
}

export class InboxConversationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) distributorId!: string;
  @ApiProperty({ enum: CANALES }) channel!: Channel;
  @ApiProperty({ enum: [SubjectType.GENERAL, SubjectType.ORDER] })
  subjectType!: SubjectType;
  @ApiProperty({ type: InboxOrderDto, nullable: true })
  order!: InboxOrderDto | null;
  @ApiProperty({ type: InboxCounterpartDto })
  counterpart!: InboxCounterpartDto;
  @ApiPropertyOptional({
    type: InboxPersonDto,
    nullable: true,
    description: 'Sólo para el personal (C3)',
  })
  customer?: InboxPersonDto | null;
  @ApiPropertyOptional({
    type: InboxPersonDto,
    nullable: true,
    description: 'Sólo para el personal (C2)',
  })
  driver?: InboxPersonDto | null;
  @ApiProperty({ enum: ConversationStatus }) status!: ConversationStatus;
  @ApiProperty({
    description:
      'Ya evaluado por el back: abierta y, para el cliente, con el chat de clientes prendido',
  })
  canWrite!: boolean;
  @ApiPropertyOptional({
    type: InboxAssigneeDto,
    nullable: true,
    description: 'Sólo para el personal: quién la atiende; `null`, en la cola',
  })
  assignedTo?: InboxAssigneeDto | null;
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Sólo para el personal: el reclamo creado desde el hilo',
  })
  linkedClaimId?: string | null;
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Sólo para el personal: la primera respuesta de la empresa al cliente o al chofer',
  })
  firstResponseAt?: string | null;
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Sólo para el personal: desde cuándo espera a una persona porque el asistente con IA se la pasó (C3); `null` si no espera. Se limpia cuando alguien la toma.',
  })
  awaitingHumanSince?: string | null;
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description:
      'Sólo para el personal: minutos hábiles (horario de atención, sin días sin atención) entre el primer mensaje del cliente o del chofer y la primera respuesta; `null` si todavía no hubo las dos cosas',
  })
  firstResponseBusinessMinutes?: number | null;
  @ApiPropertyOptional({
    description:
      'Sólo para el personal: menciones sin leer a quien pide en las notas internas de esta conversación («Me mencionaron»)',
  })
  unreadMentions?: number;
  @ApiPropertyOptional({
    type: [InboxLabelDto],
    description:
      'Sólo para el personal: las etiquetas de la conversación (hasta 5, por nombre). Al cliente y al chofer nunca les llegan.',
  })
  labels?: InboxLabelDto[];
  @ApiPropertyOptional({
    type: ExpectedReplyResponseDto,
    description:
      'Sólo en el detalle de la bandeja (`GET /v2/conversations/:id`): el tiempo de respuesta esperado que ve hoy el cliente o el chofer en ese canal',
  })
  expectedReply?: ExpectedReplyResponseDto;
  @ApiPropertyOptional({
    type: InboxCsatDto,
    nullable: true,
    description:
      'Sólo en las conversaciones con un cliente (C3), para el personal y para el cliente: la encuesta del último cierre; `null` si no hubo',
  })
  csat?: InboxCsatDto | null;
  @ApiProperty({
    type: InboxLastMessageDto,
    nullable: true,
    description:
      'El último mensaje visible para las dos puntas (nunca una nota interna)',
  })
  lastMessage!: InboxLastMessageDto | null;
  @ApiProperty({ description: 'Sin leer para quien pide' })
  unreadCount!: number;
  @ApiProperty({
    description: 'Hasta dónde leyó quien pide (separador «sin leer»)',
  })
  lastReadSeq!: number;
  @ApiProperty({ description: 'Hasta dónde leyó la otra punta (el «leído»)' })
  counterpartLastReadSeq!: number;
  @ApiProperty({ enum: ConversationClosedReason, nullable: true })
  closedReason!: ConversationClosedReason | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

/** El mensaje al que responde otro (D-C25), resumido. */
export class InboxReplyToDto {
  @ApiProperty() seq!: number;
  @ApiProperty({ enum: Party }) party!: Party;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Vista previa (140 caracteres); nula si se redactó',
  })
  preview!: string | null;
}

export class InboxSenderDto {
  @ApiProperty({
    description:
      'Para el personal, el nombre de quien escribió; para el cliente y el chofer, el de la empresa en los mensajes de la empresa (el de su marca si lo cargó; si no, el legal; D-C5)',
  })
  displayName!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Id de usuario de quien escribió, sólo para el personal (para su foto de perfil); al cliente y al chofer nunca les llega (D-C5)',
  })
  userId?: string;
}

/** Alguien del personal mencionado en una nota interna. */
export class InboxMentionDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ example: 'Juan Pérez' }) fullName!: string;
}

export class InboxMessageDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) conversationId!: string;
  @ApiProperty() seq!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Sólo en los propios',
  })
  clientMessageId!: string | null;
  @ApiProperty({ enum: Party }) party!: Party;
  @ApiProperty({ type: InboxSenderDto, nullable: true })
  sender!: InboxSenderDto | null;
  @ApiProperty({ description: 'Lo escribió la punta de quien pide' })
  isMine!: boolean;
  @ApiProperty({
    description:
      'Lo escribió quien pide (la persona, no su equipo), es un texto, está en los 15 minutos y no quedó atado (conversación por un pedido, parte de un reclamo o un ticket, o ya citado en una respuesta): se puede editar. La misma regla que el PATCH. Por el socket llega siempre `false`: es de la sala, no de una persona',
  })
  canEdit!: boolean;
  @ApiProperty({ enum: MessageKind }) kind!: MessageKind;
  @ApiProperty({
    description:
      'Nota interna: sólo la ve el personal de la empresa (al cliente y al chofer nunca les llega). La del personal es `kind: text`; la del asistente con IA al derivar, `kind: system` con `systemCode: handoff_note` y el resumen y el motivo en `body`',
  })
  internal!: boolean;
  @ApiPropertyOptional({
    type: [InboxMentionDto],
    description:
      'Sólo para el personal, en las notas internas: a quiénes menciona',
  })
  mentions?: InboxMentionDto[];
  @ApiPropertyOptional({
    type: [InboxActionDto],
    description:
      'Sólo para el cliente, en el primer mensaje del asistente de la conversación: los botones de acción que muestra la empresa (4e)',
  })
  actions?: InboxActionDto[];
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Nulo si se redactó o si lo borró su autor',
  })
  body!: string | null;
  @ApiProperty({
    type: ChatAttachmentDto,
    nullable: true,
    description:
      'Sólo `kind = attachment`: el archivo o la foto, sin URL (se pide con `GET …/messages/:messageId/attachment`). `body` es su epígrafe. Nulo si se redactó.',
  })
  attachment!: ChatAttachmentDto | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Respuesta rápida o automática que se usó',
  })
  templateKey!: string | null;
  @ApiProperty({ enum: SystemCode, nullable: true })
  systemCode!: SystemCode | null;
  @ApiProperty({
    description:
      'Lo mandó el asistente (fuera de horario, aviso de recibido): mostrarlo con la marca «Respuesta automática»',
  })
  automated!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Asistente de Gas del Sur',
    description:
      'Con `automated`, el nombre con que firmó el asistente al mandarlo (cambiarlo después no reescribe el historial; los anteriores a guardarlo, el vigente); `null` en los demás',
  })
  senderLabel!: string | null;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description:
      "`claim_created`: `{ claimId }`; respuesta fuera de horario: `{ until, senderLabel }` (fin del período cerrado y firma); aviso de recibido: `{ senderLabel }`; encuesta (`csat_request`): `{ ratingId, expiresAt, scale: 5 }`; respuesta del asistente con IA: `{ senderLabel, ai: { model, handoff?, sources? } }`, donde `ai.sources` (sólo para el personal: al cliente nunca le llega) son las fuentes de la respuesta, `[{ type: 'faq', faqId, question } | { type: 'tool', tool, orderNumber? }]`; nota de derivación (`handoff_note`, sólo el personal): `{ ai: { model, handoff: true }, handoff: { reason, reasonLabel, summary } }` (`summary` nulo si el modelo no corrió)",
  })
  payload!: Record<string, unknown> | null;
  @ApiProperty({ type: InboxReplyToDto, nullable: true })
  replyTo!: InboxReplyToDto | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Última edición (marca «editado»)',
  })
  editedAt!: string | null;
  @ApiProperty({
    description:
      'Lo borró su autor (D-C23): queda en su lugar, sin texto (`body: null`); «Mensaje eliminado» lo arma el front',
  })
  deleted!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  deletedAt!: string | null;
  @ApiProperty() redacted!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class InboxMessageListResponseDto {
  @ApiProperty({ type: [InboxMessageDto], description: 'En orden de `seq`' })
  items!: InboxMessageDto[];
  @ApiProperty({ description: 'Hay más en la dirección pedida' })
  hasMore!: boolean;
}

export class InboxCountsDto {
  @ApiProperty({
    description: 'Abiertas sin asignar (de los canales que atiende)',
  })
  unassigned!: number;
  @ApiProperty({ description: 'Abiertas asignadas a quien pide' })
  mine!: number;
  @ApiProperty({ description: 'Abiertas' }) open!: number;
}

/** Las insignias del menú «Mensajes» y de las pestañas de la bandeja. */
export class InboxSummaryDto {
  @ApiProperty({
    example: 3,
    description: 'Abiertas sin asignar (pestaña «Sin asignar»)',
  })
  unassigned!: number;
  @ApiProperty({
    example: 2,
    description: 'Abiertas asignadas a quien pide (pestaña «Mías»)',
  })
  mine!: number;
  @ApiProperty({
    example: 1,
    description:
      'Abiertas que esperan a una persona: el asistente con IA las derivó y nadie las tomó todavía',
  })
  awaitingHuman!: number;
  @ApiProperty({
    example: 4,
    description:
      'Abiertas con algún mensaje sin leer para quien pide (cuenta conversaciones, no mensajes): lo del cliente o el chofer posterior a su lectura, sin avisos del sistema, respuestas automáticas, notas internas ni mensajes borrados. No cuenta las asignadas a otra persona (ésas las atiende ella).',
  })
  unread!: number;
  @ApiProperty({
    example: 5,
    description:
      'Abiertas que piden atención, contadas una vez: sin asignar, esperando a una persona o con algo sin leer (la regla de `unread`). Es la insignia del menú «Mensajes».',
  })
  attention!: number;
  @ApiProperty({
    example: 1,
    description:
      'Menciones sin leer a quien pide en notas internas de los canales que atiende (vista «Me mencionaron»)',
  })
  mentions!: number;
}

export class MentionsReadResponseDto {
  @ApiProperty({ example: 2, description: 'Menciones que se marcaron leídas' })
  updated!: number;
}

/** Alguien del personal a quien se le puede asignar la conversación. */
export class InboxAssigneeOptionDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ example: 'Lucía Gómez' }) fullName!: string;
  @ApiPropertyOptional({
    description:
      'Foto de perfil (URL firmada, vence): no viene si no tiene foto',
  })
  photoUrl?: string;
}

export class InboxAssigneeListResponseDto {
  @ApiProperty({
    type: [InboxAssigneeOptionDto],
    description: 'Ordenadas por nombre',
  })
  items!: InboxAssigneeOptionDto[];
}

export class InboxListResponseDto {
  @ApiProperty({ type: [InboxConversationDto] }) items!: InboxConversationDto[];
  @ApiProperty() total!: number;
  @ApiProperty({ type: InboxCountsDto }) counts!: InboxCountsDto;
}

export class MyConversationListResponseDto {
  @ApiProperty({ type: [InboxConversationDto] }) items!: InboxConversationDto[];
  @ApiProperty() total!: number;
}

/** Abrir o seguir una conversación: la conversación y el mensaje escrito. */
export class OpenConversationResponseDto {
  @ApiProperty({ type: InboxConversationDto })
  conversation!: InboxConversationDto;
  @ApiProperty({ type: InboxMessageDto }) message!: InboxMessageDto;
}

export class BroadcastResponseDto {
  @ApiProperty({ description: 'Mensajes escritos (los repetidos no cuentan)' })
  sent!: number;
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'La conversación general de cada chofer, en el orden pedido',
  })
  conversationIds!: string[];
}

export class ClaimFromConversationResponseDto {
  @ApiProperty({ format: 'uuid' }) claimId!: string;
  @ApiProperty({ type: InboxConversationDto })
  conversation!: InboxConversationDto;
}

export class ChatSettingsResponseDto {
  @ApiProperty() customerChatEnabled!: boolean;
  @ApiProperty({
    description:
      'El asistente con IA contesta a los clientes (interruptor de la empresa, apagado por omisión)',
  })
  assistantAiEnabled!: boolean;
  @ApiProperty({
    description:
      'La empresa puede prender el asistente con IA (la plataforma le habilitó la función). Si es `false`, el asistente no contesta aunque `assistantAiEnabled` esté prendido.',
  })
  assistantAiAvailable!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Nombre del asistente tal como se guardó (puede tener `{{empresa.nombre}}`); `null`: el de omisión',
  })
  assistantName!: string | null;
  @ApiProperty({
    example: 'Asistente de Gas del Sur',
    description:
      'El nombre con que se firman las respuestas automáticas, con el nombre de la empresa puesto (`senderLabel` de los mensajes)',
  })
  effectiveAssistantName!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Lo que dice el asistente al pasar la conversación a una persona; `null`: el de omisión',
  })
  handoffMessage!: string | null;
  @ApiProperty({
    description:
      'El texto de derivación que se usa (el propio o el de omisión), con sus variables sin completar',
  })
  effectiveHandoffMessage!: string;
  @ApiProperty() outOfHoursEnabled!: boolean;
  @ApiProperty({ type: String, nullable: true }) outOfHoursMessage!:
    | string
    | null;
  @ApiProperty({
    description: 'El texto que se manda (el propio o el de omisión)',
  })
  effectiveOutOfHoursMessage!: string;
  @ApiProperty() ackEnabled!: boolean;
  @ApiProperty({ type: String, nullable: true }) ackMessage!: string | null;
  @ApiProperty() effectiveAckMessage!: string;
  @ApiProperty() firstResponseTargetMinutes!: number;
  @ApiProperty({
    description: 'Encuesta de satisfacción al cerrar con un cliente',
  })
  csatEnabled!: boolean;
  @ApiProperty({ type: String, nullable: true }) csatMessage!: string | null;
  @ApiProperty({
    description:
      'El texto del pedido de calificación que se usa (el propio o el de omisión), con sus variables sin completar',
  })
  effectiveCsatMessage!: string;
  @ApiProperty({
    type: [String],
    enum: CLAVES_DE_ACCION,
    description: 'Los botones de acción que ve el cliente en el chat',
  })
  customerActions!: string[];
  @ApiProperty({
    description:
      'Se muestra al cliente y al chofer el tiempo de respuesta esperado',
  })
  expectedReplyEnabled!: boolean;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Minutos sin respuesta del cliente o del chofer para cerrar sola la conversación; `null`: no se cierra sola',
  })
  inactivityCloseMinutes!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Minutos antes del cierre en que se avisa; `null`: cierra sin avisar',
  })
  inactivityWarningMinutes!: number | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Desde cuándo rigen los plazos de inactividad (se prendió o se cambió el cierre o el aviso): lo anterior no cuenta; `null` si está apagado',
  })
  inactivityEnabledAt!: string | null;
  @ApiProperty({
    description: 'Si la empresa atiende ahora (horario y días sin atención)',
  })
  openNow!: boolean;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Cuándo vuelve a atender; `null` si atiende ahora',
  })
  nextOpenAt!: string | null;
}

/** Una respuesta guardada sugerida, con sus variables ya completadas para la conversación. */
export class InboxSuggestionDto {
  @ApiProperty({ format: 'uuid' }) templateId!: string;
  @ApiProperty({ example: 'medios_de_pago' }) key!: string;
  @ApiProperty({ example: 'Medios de pago' }) title!: string;
  @ApiProperty({
    example: 'Hola Ana, podés pagar en efectivo o con Mercado Pago.',
    description:
      'El texto listo para editar en el compositor (no se manda solo)',
  })
  body!: string;
}

export class InboxSuggestionsResponseDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'El `seq` del mensaje del cliente o del chofer con que se buscó; `null` si todavía no escribió nada',
  })
  basedOnSeq!: number | null;
  @ApiProperty({
    type: [InboxSuggestionDto],
    maxItems: 3,
    description:
      'Hasta 3, de la más parecida a la menos. Vacía si ninguna se parece.',
  })
  items!: InboxSuggestionDto[];
}

export class ChatHolidayResponseDto {
  @ApiProperty({ example: '2026-12-25' }) date!: string;
  @ApiProperty() reason!: string;
}

export class ChatBusinessHoursResponseDto {
  @ApiProperty() timezone!: string;
  @ApiProperty({ type: [ChatHoursDto] }) days!: ChatHoursDto[];
  @ApiProperty({ type: [ChatHolidayResponseDto] })
  holidays!: ChatHolidayResponseDto[];
  @ApiProperty() openNow!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  nextOpenAt!: string | null;
}

export class CompanyTemplateResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: CANALES, nullable: true }) channel!: Channel | null;
  @ApiProperty() key!: string;
  @ApiProperty() title!: string;
  @ApiProperty() body!: string;
  @ApiProperty() active!: boolean;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class CompanyTemplateListResponseDto {
  @ApiProperty({ type: [CompanyTemplateResponseDto] })
  items!: CompanyTemplateResponseDto[];
}
