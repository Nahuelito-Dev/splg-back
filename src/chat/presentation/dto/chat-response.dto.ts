import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Channel,
  ConversationClosedReason,
  ConversationStatus,
  MessageKind,
  MessageVisibility,
  Party,
  SubjectType,
  SystemCode,
  TicketCategory,
  TicketPriority,
  TicketStatus,
} from '../../domain/chat.enums';

/** La otra punta, tal como la ve quien pide. */
export class CounterpartDto {
  @ApiProperty({ enum: Party }) party!: Party;
  @ApiProperty({ example: 'Soporte OrixTech' }) displayName!: string;
  @ApiProperty({ type: String, nullable: true }) photoUrl!: string | null;
}

export class LastMessageDto {
  @ApiProperty() seq!: number;
  @ApiProperty({ type: String, nullable: true }) preview!: string | null;
  @ApiProperty({ format: 'date-time' }) at!: string;
  @ApiProperty({ enum: Party }) party!: Party;
}

/** Quién de la plataforma atiende (sólo la ve la plataforma). */
export class AssignedToDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() fullName!: string;
}

/** Quién atiende, como lo ve la empresa: el nombre de pila (D-C19). */
export class AttendedByDto {
  @ApiProperty({ example: 'Lucía' }) displayName!: string;
}

export class TicketSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'T-000123' }) number!: string;
  @ApiProperty() subject!: string;
  @ApiProperty({ enum: TicketStatus }) status!: TicketStatus;
  @ApiProperty({ enum: TicketPriority }) priority!: TicketPriority;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty({
    description:
      'Mensajes del hilo sin leer para quien pide (sin los de sistema ni los propios)',
  })
  unreadCount!: number;
  @ApiProperty({
    type: () => LastMessageDto,
    nullable: true,
    description: 'El último mensaje del hilo que quien pide puede ver',
  })
  lastMessage!: LastMessageDto | null;
}

export class TicketOriginDto {
  @ApiProperty({ format: 'uuid', description: 'El chat de origen' })
  conversationId!: string;
  @ApiProperty() fromSeq!: number;
  @ApiProperty() toSeq!: number;
}

export class SupportSessionRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'pending' }) status!: string;
}

export class TicketDto extends TicketSummaryDto {
  @ApiProperty({ format: 'uuid' }) distributorId!: string;
  @ApiProperty() distributorName!: string;
  @ApiProperty({ enum: TicketCategory }) category!: TicketCategory;
  @ApiProperty({ format: 'uuid', description: 'El hilo propio del ticket' })
  conversationId!: string;
  @ApiProperty({ type: TicketOriginDto, nullable: true })
  origin!: TicketOriginDto | null;
  @ApiProperty({ enum: [Party.COMPANY, Party.PLATFORM] })
  openedBy!: Party.COMPANY | Party.PLATFORM;
  @ApiPropertyOptional({
    type: AssignedToDto,
    nullable: true,
    description: 'Sólo para la plataforma',
  })
  assignedTo?: AssignedToDto | null;
  @ApiPropertyOptional({
    type: AttendedByDto,
    nullable: true,
    description: 'Sólo para la empresa',
  })
  attendedBy?: AttendedByDto | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  firstResponseDueAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  firstResponseAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  resolvedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt!: string | null;
  @ApiProperty({ type: Number, nullable: true }) satisfaction!: number | null;
  @ApiProperty({
    type: [SupportSessionRefDto],
    description: 'Sesiones de soporte pedidas con este número de ticket',
  })
  supportSessions!: SupportSessionRefDto[];
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class ConversationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) distributorId!: string;
  @ApiProperty() distributorName!: string;
  @ApiProperty({ enum: Channel }) channel!: Channel;
  @ApiProperty({ enum: SubjectType }) subjectType!: SubjectType;
  @ApiProperty({ type: CounterpartDto }) counterpart!: CounterpartDto;
  @ApiProperty({ enum: ConversationStatus }) status!: ConversationStatus;
  @ApiProperty({
    description:
      'Ya evaluado por el back: abierta (y, en el hilo de un ticket, ticket no cerrado)',
  })
  canWrite!: boolean;
  @ApiPropertyOptional({
    type: AssignedToDto,
    nullable: true,
    description: 'Sólo para la plataforma: quién atiende el chat',
  })
  assignedTo?: AssignedToDto | null;
  @ApiPropertyOptional({
    type: AttendedByDto,
    nullable: true,
    description: 'Sólo para la empresa: quién de la plataforma la atiende',
  })
  attendedBy?: AttendedByDto | null;
  @ApiProperty({ type: LastMessageDto, nullable: true })
  lastMessage!: LastMessageDto | null;
  @ApiProperty({ description: 'Sin leer para quien pide' })
  unreadCount!: number;
  @ApiProperty({ description: 'Hasta dónde leyó la otra punta (el «leído»)' })
  counterpartLastReadSeq!: number;
  @ApiPropertyOptional({
    type: TicketDto,
    description: 'Sólo en el hilo de un ticket: su ticket',
  })
  ticket?: TicketDto;
  @ApiPropertyOptional({
    type: [TicketSummaryDto],
    description: 'Sólo en el chat: los tickets que salieron de él',
  })
  ticketsFromHere?: TicketSummaryDto[];
  @ApiProperty({
    enum: ConversationClosedReason,
    nullable: true,
  })
  closedReason!: ConversationClosedReason | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class QuotedItemDto {
  @ApiProperty() seq!: number;
  @ApiProperty({ enum: Party }) party!: Party;
  @ApiProperty({ type: String, nullable: true }) body!: string | null;
  @ApiProperty({ format: 'date-time' }) at!: string;
}

export class SenderDto {
  @ApiProperty({
    description:
      'Para la plataforma, el nombre completo; para la empresa, el nombre de pila de quien la atiende',
  })
  displayName!: string;
}

export class CitedTicketDto {
  @ApiProperty({ format: 'uuid' }) ticketId!: string;
  @ApiProperty({ example: 'T-000123' }) number!: string;
}

export class MessageDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) conversationId!: string;
  @ApiProperty() seq!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Sólo en los de la propia punta',
  })
  clientMessageId!: string | null;
  @ApiProperty({ enum: Party }) party!: Party;
  @ApiProperty({ type: SenderDto, nullable: true }) sender!: SenderDto | null;
  @ApiProperty({ description: 'Lo escribió la punta de quien pide' })
  isMine!: boolean;
  @ApiProperty({ enum: MessageKind }) kind!: MessageKind;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description:
      '`quoted_excerpt`: `{ sourceConversationId, fromSeq, toSeq, items: [{ seq, party, body, at }] }`. `system` `ticket_opened`/`ticket_created`: `{ ticketId, number, subject }`; `ticket_status_changed`: `{ ticketId, number, from, to }`',
  })
  payload!: Record<string, unknown> | null;
  @ApiProperty({
    type: [CitedTicketDto],
    description: 'Sólo en el chat: los tickets que citan este mensaje',
  })
  citedInTickets!: CitedTicketDto[];
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Nulo si se redactó',
  })
  body!: string | null;
  @ApiProperty() bodyFiltered!: boolean;
  @ApiProperty({ type: String, nullable: true }) templateKey!: string | null;
  @ApiProperty({ enum: SystemCode, nullable: true })
  systemCode!: SystemCode | null;
  @ApiProperty({
    enum: MessageVisibility,
    description: '`internal` sólo llega a la plataforma',
  })
  visibility!: MessageVisibility;
  @ApiProperty() redacted!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class MessageListResponseDto {
  @ApiProperty({ type: [MessageDto], description: 'En orden de `seq`' })
  items!: MessageDto[];
  @ApiProperty({ description: 'Hay más en la dirección pedida' })
  hasMore!: boolean;
}

export class ConversationListResponseDto {
  @ApiProperty({ type: [ConversationDto] }) items!: ConversationDto[];
  @ApiProperty() total!: number;
}

export class PlatformChatCountsDto {
  @ApiProperty({ description: 'Abiertos sin nadie atendiendo' })
  waiting!: number;
  @ApiProperty({ description: 'Abiertos que atiendo yo' }) mine!: number;
}

export class PlatformChatListResponseDto extends ConversationListResponseDto {
  @ApiProperty({ type: PlatformChatCountsDto }) counts!: PlatformChatCountsDto;
}

export class CompanyPlatformChatResponseDto {
  @ApiProperty({
    type: ConversationDto,
    nullable: true,
    description: 'El chat abierto, o `null` si no hay',
  })
  conversation!: ConversationDto | null;
}

export class TicketListResponseDto {
  @ApiProperty({ type: [TicketSummaryDto] }) items!: TicketSummaryDto[];
  @ApiProperty() total!: number;
}

export class PlatformTicketCountsDto {
  @ApiProperty() new!: number;
  @ApiProperty() open!: number;
  @ApiProperty() waitingCompany!: number;
  @ApiProperty({ description: 'Abiertos asignados a mí' }) mine!: number;
  @ApiProperty({
    description: 'Sin primera respuesta y con el objetivo vencido',
  })
  overdue!: number;
}

export class PlatformTicketListResponseDto {
  @ApiProperty({ type: [TicketDto] }) items!: TicketDto[];
  @ApiProperty() total!: number;
  @ApiProperty({ type: PlatformTicketCountsDto })
  counts!: PlatformTicketCountsDto;
}

/** Insignia «Ayuda» del panel de la empresa. */
export class CompanySupportSummaryDto {
  @ApiProperty({
    description:
      'Mensajes sin leer (para quien pide) en el chat abierto con la plataforma',
  })
  chatUnread!: number;
  @ApiProperty({ description: 'Tickets con al menos un mensaje sin leer' })
  ticketsUnread!: number;
  @ApiProperty({
    description: 'Lo que muestra la insignia: `chatUnread + ticketsUnread`',
  })
  total!: number;
}

/** Insignias del soporte en el panel de la plataforma. */
export class PlatformSupportSummaryDto {
  @ApiProperty({
    description: 'Chats abiertos con algo sin leer para quien pide',
  })
  chatsUnread!: number;
  @ApiProperty({ description: 'Chats abiertos que nadie atiende' })
  chatsUnassigned!: number;
  @ApiProperty({
    description: 'Tickets no cerrados con algo sin leer para quien pide',
  })
  ticketsUnread!: number;
  @ApiProperty({ description: 'Tickets no cerrados sin asignar' })
  ticketsUnassigned!: number;
  @ApiProperty({
    description: 'Lo que muestra la insignia: `chatsUnread + ticketsUnread`',
  })
  total!: number;
}
