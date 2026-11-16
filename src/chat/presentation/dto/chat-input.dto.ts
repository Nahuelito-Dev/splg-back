import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  ConversationStatus,
  MessageVisibility,
  TicketCategory,
  TicketPriority,
  TicketStatus,
} from '../../domain/chat.enums';

/** Quita los espacios de los extremos de un texto (lo demás pasa tal cual). */
const Recortar = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/** `'true'` / `'false'` de la query a booleano. */
const ABooleano = () =>
  Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  );

/**
 * Una lista de la query: `a,b` o el parámetro repetido (`?x=a&x=b`). Sin
 * espacios, sin vacíos y sin repetidos; lo que no es texto pasa tal cual
 * para que la validación lo rechace.
 */
const ALista = () =>
  Transform(({ value }: { value: unknown }) => {
    const partes: unknown[] | null = Array.isArray(value)
      ? value.flatMap((v: unknown) =>
          typeof v === 'string' ? v.split(',') : [v],
        )
      : typeof value === 'string'
        ? value.split(',')
        : null;
    if (!partes) return value;
    return [
      ...new Set(
        partes
          .map((v) => (typeof v === 'string' ? v.trim() : v))
          .filter((v) => v !== ''),
      ),
    ];
  });

/** Enviar un mensaje (§14.1). Reintentar con el mismo `clientMessageId` no lo duplica. */
export class SendMessageDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Lo genera quien escribe. El mismo id repetido devuelve el mensaje ya guardado (200) en vez de duplicarlo.',
  })
  @IsUUID('4')
  clientMessageId!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 2000,
    example: '¿Dónde cargo el logo de la empresa?',
  })
  @Recortar()
  @IsString()
  @Length(1, 2000)
  body!: string;
}

/** Mensaje de la plataforma en el hilo de un ticket: puede ser una nota interna (D-C8). */
export class PlatformTicketMessageDto extends SendMessageDto {
  @ApiPropertyOptional({
    enum: MessageVisibility,
    default: MessageVisibility.ALL,
    description:
      '`internal`: nota interna, la empresa no la ve (ni por la API ni por el socket).',
  })
  @IsOptional()
  @IsEnum(MessageVisibility)
  visibility: MessageVisibility = MessageVisibility.ALL;
}

/** Hasta qué mensaje leyó quien pide. */
export class ReadUpToDto {
  @ApiProperty({ minimum: 0, example: 12 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  seq!: number;
}

/** Página de mensajes por número: los posteriores a `afterSeq` o los anteriores a `beforeSeq`. */
export class MessagesQueryDto {
  @ApiPropertyOptional({
    minimum: 0,
    description: 'Los posteriores a este número (reconexión).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  afterSeq?: number;

  @ApiPropertyOptional({
    minimum: 1,
    description:
      'Los anteriores a este número (historial hacia atrás). Sin ninguno de los dos, los últimos.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  beforeSeq?: number;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;
}

export class ChatPaginationDto {
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

/** Abrir un ticket directo, desde la empresa. */
export class CreateCompanyTicketDto {
  @ApiProperty({ enum: TicketCategory })
  @IsEnum(TicketCategory)
  category!: TicketCategory;

  @ApiProperty({
    enum: TicketPriority,
    description: 'La empresa la propone; la plataforma la puede ajustar.',
  })
  @IsEnum(TicketPriority)
  priority!: TicketPriority;

  @ApiProperty({
    minLength: 5,
    maxLength: 120,
    example: 'Factura de octubre duplicada',
  })
  @Recortar()
  @IsString()
  @Length(5, 120)
  subject!: string;

  @ApiProperty({
    type: SendMessageDto,
    description:
      'Primer mensaje del hilo. Reintentar con el mismo `clientMessageId` devuelve el ticket ya creado (200).',
  })
  @ValidateNested()
  @Type(() => SendMessageDto)
  firstMessage!: SendMessageDto;
}

/** Abrir un ticket directo, desde la plataforma, hacia una empresa. */
export class CreatePlatformTicketDto extends CreateCompanyTicketDto {
  @ApiProperty({ format: 'uuid', description: 'La empresa' })
  @IsUUID('4')
  distributorId!: string;
}

/** Abrir un ticket desde el chat, citando los mensajes `fromSeq`–`toSeq` (hasta 200). */
export class OpenTicketFromChatDto {
  @ApiProperty({ enum: TicketCategory })
  @IsEnum(TicketCategory)
  category!: TicketCategory;

  @ApiProperty({ enum: TicketPriority })
  @IsEnum(TicketPriority)
  priority!: TicketPriority;

  @ApiProperty({ minLength: 5, maxLength: 120 })
  @Recortar()
  @IsString()
  @Length(5, 120)
  subject!: string;

  @ApiProperty({ minimum: 1, example: 3 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  fromSeq!: number;

  @ApiProperty({ minimum: 1, example: 7 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  toSeq!: number;

  @ApiPropertyOptional({
    maxLength: 2000,
    description:
      'Primer mensaje propio del hilo del ticket, después de la cita.',
  })
  @IsOptional()
  @Recortar()
  @IsString()
  @Length(1, 2000)
  note?: string;
}

export class PlatformOpenTicketFromChatDto extends OpenTicketFromChatDto {
  @ApiPropertyOptional({
    default: false,
    description: 'Queda asignado a quien lo abre.',
  })
  @IsOptional()
  @IsBoolean()
  assignToMe: boolean = false;
}

/** Llevar más mensajes del chat de la empresa al hilo de un ticket (se copian; el chat queda igual). */
export class AddExcerptDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Un chat de la misma empresa que el ticket',
  })
  @IsUUID('4')
  sourceConversationId!: string;

  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  fromSeq!: number;

  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  toSeq!: number;
}

export class ConfirmTicketDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 5, description: 'Calificación' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  satisfaction?: number;
}

/** Cambios de la plataforma sobre un ticket: lo que no viene queda como estaba. */
export class UpdateTicketDto {
  @ApiPropertyOptional({
    enum: TicketStatus,
    description:
      'Según la máquina del ticket; una transición inválida es 400 `TICKET_INVALID_TRANSITION`. `closed` nunca se acepta a mano (400 `TICKET_INVALID_TRANSITION`): el ticket se cierra solo a los 7 días (plazo configurable, resuelto o esperando a la empresa) o cuando la empresa confirma la resolución.',
  })
  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  @ApiPropertyOptional({ enum: TicketPriority })
  @IsOptional()
  @IsEnum(TicketPriority)
  priority?: TicketPriority;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Un administrador general activo; `null` lo desasigna.',
  })
  @IsOptional()
  @IsUUID('4')
  assignedTo?: string | null;

  @ApiPropertyOptional({ enum: TicketCategory })
  @IsOptional()
  @IsEnum(TicketCategory)
  category?: TicketCategory;
}

/** Por qué se puede ordenar un listado de tickets. */
export const ORDEN_DE_TICKETS = [
  'createdAt',
  'updatedAt',
  'lastMessageAt',
] as const;
export type OrdenDeTickets = (typeof ORDEN_DE_TICKETS)[number];
export const SENTIDO_DE_TICKETS = ['asc', 'desc'] as const;
export type SentidoDeTickets = (typeof SENTIDO_DE_TICKETS)[number];

export class QueryCompanyTicketsDto extends ChatPaginationDto {
  @ApiPropertyOptional({
    enum: TicketStatus,
    isArray: true,
    example: 'new,open,waiting_company',
    description:
      'Uno o varios estados, separados por coma (`new,open,waiting_company`) o repitiendo el parámetro (`status=new&status=open`). Sin él, todos.',
  })
  @IsOptional()
  @ALista()
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(TicketStatus, { each: true })
  status?: TicketStatus[];

  @ApiPropertyOptional({
    maxLength: 120,
    description: 'Número (`T-000123` o `123`) o parte del asunto',
  })
  @IsOptional()
  @Recortar()
  @IsString()
  @Length(1, 120)
  q?: string;

  @ApiPropertyOptional({
    enum: ORDEN_DE_TICKETS,
    default: 'updatedAt',
    description:
      'Campo por el que se ordena: alta, último movimiento del ticket o último mensaje del hilo que quien pide puede ver (la empresa no cuenta las notas internas). Empate: por número.',
  })
  @IsOptional()
  @IsIn(ORDEN_DE_TICKETS)
  sort: OrdenDeTickets = 'updatedAt';

  @ApiPropertyOptional({
    enum: SENTIDO_DE_TICKETS,
    default: 'desc',
    description: 'Sentido del orden: `desc`, los más recientes primero',
  })
  @IsOptional()
  @IsIn(SENTIDO_DE_TICKETS)
  order: SentidoDeTickets = 'desc';
}

/** `me`, `none` o el id de un administrador general. */
const ASIGNADO =
  /^(me|none|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export class QueryPlatformTicketsDto extends QueryCompanyTicketsDto {
  @ApiPropertyOptional({ enum: TicketPriority })
  @IsOptional()
  @IsEnum(TicketPriority)
  priority?: TicketPriority;

  @ApiPropertyOptional({ format: 'uuid', description: 'La empresa' })
  @IsOptional()
  @IsUUID('4')
  distributorId?: string;

  @ApiPropertyOptional({
    description: '`me` (los míos), `none` (sin asignar) o el id de un miembro',
  })
  @IsOptional()
  @Matches(ASIGNADO)
  assigned?: string;

  @ApiPropertyOptional({
    description:
      'Sólo los que pasaron su objetivo de primera respuesta sin respuesta',
  })
  @IsOptional()
  @ABooleano()
  @IsBoolean()
  overdue?: boolean;

  @ApiPropertyOptional({ description: 'Sólo los abiertos desde un chat' })
  @IsOptional()
  @ABooleano()
  @IsBoolean()
  fromChat?: boolean;
}

export class QueryPlatformChatsDto extends ChatPaginationDto {
  @ApiPropertyOptional({
    enum: ConversationStatus,
    default: ConversationStatus.OPEN,
  })
  @IsOptional()
  @IsEnum(ConversationStatus)
  status: ConversationStatus = ConversationStatus.OPEN;

  @ApiPropertyOptional({
    description: '`me` (los míos), `none` (sin atender) o el id de un miembro',
  })
  @IsOptional()
  @Matches(ASIGNADO)
  assigned?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'La empresa' })
  @IsOptional()
  @IsUUID('4')
  distributorId?: string;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      '`true`: sólo los que esperan a una persona (el asistente con IA los derivó); `false`: sólo los que no. Con `assigned=none`, los que esperan van primero (el que espera hace más, primero).',
  })
  @IsOptional()
  @ABooleano()
  @IsBoolean()
  awaiting?: boolean;
}

/** Escribirle a una empresa (crea su chat o usa el abierto). */
export class StartPlatformChatDto {
  @ApiProperty({ format: 'uuid', description: 'La empresa' })
  @IsUUID('4')
  distributorId!: string;

  @ApiProperty({ type: SendMessageDto })
  @ValidateNested()
  @Type(() => SendMessageDto)
  firstMessage!: SendMessageDto;
}

/** Valores de `assigned` que no son un id. */
export const ASIGNADO_A_MI = 'me';
export const SIN_ASIGNAR = 'none';
