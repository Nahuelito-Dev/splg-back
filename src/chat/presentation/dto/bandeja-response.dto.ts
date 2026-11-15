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
import { ChatHoursDto } from './support-settings.dto';

const CANALES = [Channel.STAFF_CUSTOMER, Channel.STAFF_DRIVER];

/** La otra punta, como la ve quien pide: el cliente y el chofer ven la empresa, nunca al operador (D-C5). */
export class InboxCounterpartDto {
  @ApiProperty({ enum: Party }) party!: Party;
  @ApiProperty({
    example: 'Gas Norte',
    description:
      'Para el cliente y el chofer, el nombre de la empresa; para el personal, el del cliente o el chofer',
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

/** Una conversación de la bandeja (C3 con un cliente, C2 con un chofer). */
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
    type: Number,
    nullable: true,
    description:
      'Sólo para el personal: minutos hábiles (horario de atención, sin días sin atención) entre el primer mensaje del cliente o del chofer y la primera respuesta; `null` si todavía no hubo las dos cosas',
  })
  firstResponseBusinessMinutes?: number | null;
  @ApiProperty({ type: InboxLastMessageDto, nullable: true })
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
      'Para el personal, el nombre de quien escribió; para el cliente y el chofer, el de la empresa en los mensajes de la empresa (D-C5)',
  })
  displayName!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Id de usuario de quien escribió, sólo para el personal (para su foto de perfil); al cliente y al chofer nunca les llega (D-C5)',
  })
  userId?: string;
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
      'Lo escribió quien pide (la persona, no su equipo) y está en los 15 minutos: se puede editar (por el socket llega siempre `false`: es de la sala, no de una persona)',
  })
  canEdit!: boolean;
  @ApiProperty({ enum: MessageKind }) kind!: MessageKind;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Nulo si se redactó o si lo borró su autor',
  })
  body!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Respuesta rápida o automática que se usó',
  })
  templateKey!: string | null;
  @ApiProperty({ enum: SystemCode, nullable: true })
  systemCode!: SystemCode | null;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description:
      '`claim_created`: `{ claimId }`; respuesta fuera de horario: `{ until }` (fin del período cerrado)',
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
