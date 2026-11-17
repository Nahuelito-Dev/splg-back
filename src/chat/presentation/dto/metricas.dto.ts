import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsUUID,
  Matches,
} from 'class-validator';
import { Channel } from '../../domain/chat.enums';
import { CsatGroupDto } from './bandeja-response.dto';

const DIA = /^\d{4}-\d{2}-\d{2}$/;
const CANALES = [Channel.STAFF_CUSTOMER, Channel.STAFF_DRIVER] as const;

const DESCRIPCION_DESDE =
  'Desde (día en hora argentina, AAAA-MM-DD, inclusive). Sin `from`: los 30 días que terminan en `to`.';
const DESCRIPCION_HASTA =
  'Hasta (día en hora argentina, AAAA-MM-DD, inclusive). Sin `to`: hoy. El período abarca hasta 366 días.';

/** Período de las métricas del chat: días argentinos, extremos inclusivos. */
export class ChatMetricsRangeQueryDto {
  @ApiPropertyOptional({
    example: '2026-10-18',
    description: DESCRIPCION_DESDE,
  })
  @IsOptional()
  @Matches(DIA)
  @IsDateString({ strict: true })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-11-16',
    description: DESCRIPCION_HASTA,
  })
  @IsOptional()
  @Matches(DIA)
  @IsDateString({ strict: true })
  to?: string;
}

export class QueryChatMetricsDto extends ChatMetricsRangeQueryDto {
  @ApiPropertyOptional({
    enum: CANALES,
    description:
      'Sólo un canal: clientes (C3) o choferes (C2). Sin él, los dos.',
  })
  @IsOptional()
  @IsIn(CANALES)
  channel?: Channel.STAFF_CUSTOMER | Channel.STAFF_DRIVER;
}

export class QueryPlatformChatMetricsDto extends ChatMetricsRangeQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Sólo una empresa (404 si no existe). Sin él, todas.',
  })
  @IsOptional()
  @IsUUID()
  distributorId?: string;
}

export class TargetComplianceDto {
  @ApiProperty({ description: 'Respondidas dentro del objetivo' })
  met!: number;
  @ApiProperty({
    description:
      'Respondidas fuera del objetivo, más las que siguen sin respuesta y ya lo pasaron',
  })
  missed!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 0.85,
    description: '`met / (met + missed)`, de 0 a 1; `null` si no hay ninguna',
  })
  rate!: number | null;
}

export class FirstResponseStatsDto {
  @ApiProperty({ description: 'Con primera respuesta' }) responded!: number;
  @ApiProperty({
    description:
      'Abiertas que todavía esperan la primera respuesta de una persona (las creadas en el período; coherente con `live.unanswered`, que cuenta todas las abiertas)',
  })
  unanswered!: number;
  @ApiProperty({
    description:
      'Cerradas sin respuesta de una persona (las resolvió el asistente, se cerraron por inactividad o el ticket se resolvió sin escribir): no entran en el TPR ni en el objetivo. Tampoco entra una cuya respuesta es anterior al inicio de la espera (ticket abierto desde un chat ya respondido).',
  })
  closedWithoutHumanReply!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 12,
    description:
      'Mediana del tiempo de primera respuesta, en minutos hábiles (dentro del horario de atención); `null` sin respuestas',
  })
  medianMinutes!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 45,
    description: 'Percentil 90, en minutos hábiles; `null` sin respuestas',
  })
  p90Minutes!: number | null;
  @ApiProperty({
    type: TargetComplianceDto,
    nullable: true,
    description:
      'Contra el objetivo (`firstResponseTargetMinutes` de la empresa; el vencimiento de cada ticket). `null` donde no hay objetivo (chat con la plataforma).',
  })
  target!: TargetComplianceDto | null;
}

export class ChatResolutionDto {
  @ApiProperty({
    description:
      'Cerradas (creadas en el período). No cuentan las cerradas porque el pedido pasó a otro chofer.',
  })
  closed!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Mediana de cierre − creación, en minutos de reloj corrido (no hábiles: cuenta noches, fines de semana y feriados); `null` sin cerradas',
  })
  medianMinutes!: number | null;
}

export class ChatLiveDto {
  @ApiProperty({ description: 'Abiertas ahora' }) open!: number;
  @ApiProperty({ description: 'Abiertas sin nadie asignado' })
  unassigned!: number;
  @ApiProperty({
    description:
      'Abiertas en las que el cliente o el chofer escribió y nadie del equipo respondió todavía',
  })
  unanswered!: number;
  @ApiProperty({
    description: 'Abiertas que el asistente pasó a una persona y nadie tomó',
  })
  awaitingHuman!: number;
}

export class ChatChannelMetricsDto {
  @ApiProperty({ enum: CANALES }) channel!: Channel;
  @ApiProperty({ description: 'Creadas en el período' }) conversations!: number;
  @ApiProperty({ type: FirstResponseStatsDto })
  firstResponse!: FirstResponseStatsDto;
  @ApiProperty({ type: ChatResolutionDto }) resolution!: ChatResolutionDto;
  @ApiProperty({
    type: ChatLiveDto,
    description: 'En vivo (no depende del período)',
  })
  live!: ChatLiveDto;
}

/** Una etiqueta de la bandeja en las métricas (7c). */
export class ChatLabelRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Reclamo de envío' }) name!: string;
  @ApiProperty({ example: 'orange' }) color!: string;
}

export class ChatLabelMetricsDto {
  @ApiProperty({ type: ChatLabelRefDto }) label!: ChatLabelRefDto;
  @ApiProperty({
    description:
      'Conversaciones creadas en el período (de los canales consultados) con la etiqueta puesta hoy',
  })
  conversations!: number;
  @ApiProperty({
    type: FirstResponseStatsDto,
    description: 'Su tiempo de primera respuesta (mediana en minutos hábiles)',
  })
  firstResponse!: FirstResponseStatsDto;
}

export class HandoffReasonDto {
  @ApiProperty({ example: 'requested' }) reason!: string;
  @ApiProperty({
    example:
      'El asistente no pudo resolverlo o la persona pidió hablar con alguien',
  })
  label!: string;
  @ApiProperty() count!: number;
}

export class AssistantMetricsDto {
  @ApiProperty({ description: 'Respuestas que publicó el asistente con IA' })
  aiReplies!: number;
  @ApiProperty({ description: 'Veces que pasó la conversación a una persona' })
  handoffs!: number;
  @ApiProperty({
    type: [HandoffReasonDto],
    description: 'Derivaciones por motivo, la más frecuente primero',
  })
  handoffReasons!: HandoffReasonDto[];
  @ApiProperty({ description: 'Conversaciones en las que respondió o derivó' })
  conversationsAttended!: number;
  @ApiProperty({
    description:
      'Cerradas (creadas en el período) en las que el asistente respondió al menos una vez',
  })
  closedWithAssistant!: number;
  @ApiProperty({
    description:
      'De ésas, las que no derivó y en las que nadie del equipo escribió',
  })
  resolvedWithoutHuman!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 0.6,
    description:
      '`resolvedWithoutHuman / closedWithAssistant`; `null` si no hay',
  })
  resolvedWithoutHumanRate!: number | null;
}

export class CompanyAssistantMetricsDto extends AssistantMetricsDto {
  @ApiProperty({
    description: 'Si la empresa tiene prendido el asistente con IA ahora',
  })
  enabled!: boolean;
}

export class KeyCountDto {
  @ApiProperty({ example: 'fuera_de_horario' }) key!: string;
  @ApiProperty() count!: number;
}

export class KeyCountSummaryDto {
  @ApiProperty() total!: number;
  @ApiProperty({ type: [KeyCountDto], description: 'La más usada primero' })
  byKey!: KeyCountDto[];
}

export class ScoreCountDto {
  @ApiProperty({ minimum: 1, maximum: 5 }) score!: number;
  @ApiProperty() count!: number;
}

export class ChatSatisfactionDto {
  @ApiProperty({ description: 'Encuestas pedidas al cerrar, sin las anuladas' })
  requested!: number;
  @ApiProperty() answered!: number;
  @ApiProperty({ description: 'Vencidas sin responder' }) expired!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Tasa de respuesta: `answered / requested`; `null` sin pedidas',
  })
  responseRate!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Promedio de 1 a 5',
  })
  average!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Proporción de 4 y 5 sobre las respondidas',
  })
  csat!: number | null;
  @ApiProperty({
    type: [ScoreCountDto],
    description: 'Distribución: siempre los cinco puntajes',
  })
  byScore!: ScoreCountDto[];
  @ApiProperty({
    type: CsatGroupDto,
    description: 'Atendidas sólo por el asistente',
  })
  assistant!: CsatGroupDto;
  @ApiProperty({ type: CsatGroupDto, description: 'Atendidas por el equipo' })
  team!: CsatGroupDto;
}

export class ChatDailyPointDto {
  @ApiProperty({ example: '2026-11-16' }) date!: string;
  @ApiProperty() newConversations!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Mediana del TPR (minutos hábiles) de las creadas ese día que ya tienen respuesta',
  })
  firstResponseMedianMinutes!: number | null;
}

/** Métricas de la bandeja de la empresa (B4). */
export class ChatMetricsResponseDto {
  @ApiProperty({ example: '2026-10-18' }) from!: string;
  @ApiProperty({ example: '2026-11-16' }) to!: string;
  @ApiProperty({
    enum: CANALES,
    nullable: true,
    description: 'El canal pedido; `null`: los dos',
  })
  channel!: Channel | null;
  @ApiProperty({
    example: 30,
    description: 'El objetivo de primera respuesta de la empresa, en minutos',
  })
  targetMinutes!: number;
  @ApiProperty({ description: 'Creadas en el período' }) conversations!: number;
  @ApiProperty({ type: FirstResponseStatsDto })
  firstResponse!: FirstResponseStatsDto;
  @ApiProperty({ type: ChatResolutionDto }) resolution!: ChatResolutionDto;
  @ApiProperty({
    type: ChatLiveDto,
    description: 'En vivo (no depende del período)',
  })
  live!: ChatLiveDto;
  @ApiProperty({ type: [ChatChannelMetricsDto] })
  byChannel!: ChatChannelMetricsDto[];
  @ApiProperty({
    type: [ChatLabelMetricsDto],
    description:
      'Corte por etiqueta: cada etiqueta vigente de la empresa (también las que no tienen conversaciones en el período), por nombre',
  })
  byLabel!: ChatLabelMetricsDto[];
  @ApiProperty({
    type: CompanyAssistantMetricsDto,
    nullable: true,
    description:
      'Sólo con el asistente con IA disponible para la empresa y con el canal de clientes en la consulta',
  })
  assistant!: CompanyAssistantMetricsDto | null;
  @ApiProperty({
    type: KeyCountSummaryDto,
    description:
      'Respuestas automáticas (fuera de horario, aviso de recibido, asistente) por clave',
  })
  automaticReplies!: KeyCountSummaryDto;
  @ApiProperty({
    type: KeyCountSummaryDto,
    description: 'Respuestas rápidas del equipo por `template_key`',
  })
  quickReplies!: KeyCountSummaryDto;
  @ApiProperty({
    type: ChatSatisfactionDto,
    nullable: true,
    description:
      'Encuesta al cerrar (sólo con clientes): `null` si la consulta es sólo de choferes',
  })
  satisfaction!: ChatSatisfactionDto | null;
  @ApiProperty({
    type: [ChatDailyPointDto],
    description: 'Un punto por día del período, también los vacíos',
  })
  daily!: ChatDailyPointDto[];
}

export class SupportChatMetricsDto {
  @ApiProperty({ description: 'Chats creados en el período' }) chats!: number;
  @ApiProperty({
    description:
      'Abiertos con un mensaje de la empresa sin respuesta de la plataforma (en vivo)',
  })
  waiting!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'La espera más larga de ésos, en minutos hábiles del soporte',
  })
  longestWaitMinutes!: number | null;
  @ApiProperty({ type: Number, nullable: true })
  medianWaitMinutes!: number | null;
  @ApiProperty({
    type: FirstResponseStatsDto,
    description:
      'Desde el primer mensaje de la empresa hasta la primera respuesta de la plataforma; `target` es `null`',
  })
  firstResponse!: FirstResponseStatsDto;
  @ApiProperty({
    description: 'Chats con al menos un ticket abierto desde ellos',
  })
  endedInTicket!: number;
  @ApiProperty({ type: Number, nullable: true })
  endedInTicketRate!: number | null;
}

export class TicketResolutionDto {
  @ApiProperty() resolved!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Mediana de resolución − apertura, en minutos de reloj corrido (no hábiles); `null` sin resueltos',
  })
  medianMinutes!: number | null;
}

export class TicketSatisfactionDto {
  @ApiProperty({ description: 'Tickets calificados' }) rated!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Calificados sobre cerrados (se califica al confirmar, y confirmar lo cierra)',
  })
  responseRate!: number | null;
  @ApiProperty({ type: Number, nullable: true }) average!: number | null;
  @ApiProperty({ type: [ScoreCountDto] }) byScore!: ScoreCountDto[];
}

export class TicketFirstResponseStatsDto extends FirstResponseStatsDto {
  @ApiProperty({
    type: TargetComplianceDto,
    description: 'Contra el vencimiento de primera respuesta de cada ticket',
  })
  declare target: TargetComplianceDto;
}

export class SupportTicketMetricsDto {
  @ApiProperty({ description: 'Creados en el período' }) created!: number;
  @ApiProperty({ description: 'Sin resolver ni cerrar (en vivo)' })
  open!: number;
  @ApiProperty({
    description:
      'Sin primera respuesta y con el plazo vencido, sin cerrar (en vivo)',
  })
  overdue!: number;
  @ApiProperty({
    type: TicketFirstResponseStatsDto,
    description:
      'De los abiertos por la empresa, en minutos hábiles del soporte',
  })
  firstResponse!: TicketFirstResponseStatsDto;
  @ApiProperty({ type: TicketResolutionDto }) resolution!: TicketResolutionDto;
  @ApiProperty({ type: TicketSatisfactionDto })
  satisfaction!: TicketSatisfactionDto;
}

export class CompanyChatUsageDto {
  @ApiProperty({ format: 'uuid' }) distributorId!: string;
  @ApiProperty({ example: 'Gas del Sur' }) name!: string;
  @ApiProperty({
    description: 'Conversaciones con clientes y choferes creadas en el período',
  })
  conversations!: number;
  @ApiProperty({
    description:
      'Mensajes visibles de personas en esas conversaciones (sólo el conteo)',
  })
  messages!: number;
  @ApiProperty({
    type: AssistantMetricsDto,
    nullable: true,
    description: 'Sólo si la empresa usó el asistente con IA en el período',
  })
  assistant!: AssistantMetricsDto | null;
}

/** Métricas de la plataforma: soporte, su asistente y uso por empresa (B4). */
export class PlatformChatMetricsResponseDto {
  @ApiProperty({ example: '2026-10-18' }) from!: string;
  @ApiProperty({ example: '2026-11-16' }) to!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  distributorId!: string | null;
  @ApiProperty({ type: SupportChatMetricsDto }) chat!: SupportChatMetricsDto;
  @ApiProperty({ type: SupportTicketMetricsDto })
  tickets!: SupportTicketMetricsDto;
  @ApiProperty({
    type: AssistantMetricsDto,
    description: 'El asistente del soporte de la plataforma',
  })
  assistant!: AssistantMetricsDto;
  @ApiProperty({
    type: [CompanyChatUsageDto],
    description:
      'Las empresas con conversaciones o mensajes en el período, la de más mensajes primero',
  })
  companies!: CompanyChatUsageDto[];
}
