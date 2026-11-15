import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { MessageTemplateScope } from '../../domain/chat.enums';

const Recortar = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Una franja de atención del chat de la plataforma (hora local de `timezone`). */
export class ChatHoursDto {
  @ApiProperty({ minimum: 0, maximum: 6, description: '0 = domingo' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(6)
  weekday!: number;

  @ApiProperty({ example: '09:00' })
  @Matches(HORA)
  opensAt!: string;

  @ApiProperty({ example: '18:00' })
  @Matches(HORA)
  closesAt!: string;
}

/** Configuración del soporte de la plataforma: lo que no viene queda como estaba. */
export class UpdateSupportSettingsDto {
  @ApiPropertyOptional({ example: 'America/Argentina/Buenos_Aires' })
  @IsOptional()
  @Recortar()
  @IsString()
  @Length(3, 60)
  timezone?: string;

  @ApiPropertyOptional({
    type: [ChatHoursDto],
    description:
      'Franjas de atención del chat (sin solaparse en el mismo día). Vacía: se atiende siempre.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(28)
  @ValidateNested({ each: true })
  @Type(() => ChatHoursDto)
  chatHours?: ChatHoursDto[];

  @ApiPropertyOptional({
    description:
      'Aviso automático al primer mensaje de la empresa en un chat abierto dentro del horario (una vez por apertura)',
  })
  @IsOptional()
  @IsBoolean()
  chatAckEnabled?: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 500,
    description:
      'Texto del aviso; `null` vuelve al de siempre («Recibimos tu mensaje. Alguien del equipo de <plataforma> te va a atender a la brevedad.»)',
  })
  @IsOptional()
  @Recortar()
  @IsString()
  @Length(1, 500)
  chatAckMessage?: string | null;

  @ApiPropertyOptional({
    description:
      'El asistente con IA contesta a las empresas en el chat del soporte, con la base de conocimiento de la plataforma',
  })
  // `null` no es «no cambiar»: es inválido (la columna no admite nulo).
  @ValidateIf(
    (o: UpdateSupportSettingsDto) => o.assistantAiEnabled !== undefined,
  )
  @IsBoolean()
  assistantAiEnabled?: boolean;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 50,
    description:
      'Tope de respuestas del asistente con IA por conversación (en el soporte y en el chat de cada empresa con sus clientes); al llegar, pasa la conversación a una persona',
  })
  // `null` no es «no cambiar»: es inválido (la columna no admite nulo).
  @ValidateIf(
    (o: UpdateSupportSettingsDto) =>
      o.assistantRepliesPerConversation !== undefined,
  )
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  assistantRepliesPerConversation?: number;

  @ApiPropertyOptional({
    minimum: 10000,
    maximum: 1000000000,
    description:
      'Tope de tokens por mes del asistente con IA, para cada empresa y para el soporte (entrada, salida y caché). Al llegar, sólo las respuestas automáticas fijas y pasar a una persona.',
  })
  // `null` no es «no cambiar»: es inválido (la columna no admite nulo).
  @ValidateIf(
    (o: UpdateSupportSettingsDto) => o.assistantMonthlyTokenLimit !== undefined,
  )
  @Type(() => Number)
  @IsInt()
  @Min(10000)
  @Max(1000000000)
  assistantMonthlyTokenLimit?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 168,
    description: 'Horas sin mensajes para cerrar el chat',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(168)
  chatInactivityHours?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  resolvedCloseDays?: number;

  @ApiPropertyOptional({ minimum: 2, maximum: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(30)
  waitingCloseDays?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 29,
    description: 'Tiene que ser menor que los días para cerrarlo',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(29)
  waitingWarnDays?: number;

  @ApiPropertyOptional({ minimum: 5, maximum: 43200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(43200)
  targetUrgentMinutes?: number;

  @ApiPropertyOptional({ minimum: 5, maximum: 43200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(43200)
  targetHighMinutes?: number;

  @ApiPropertyOptional({ minimum: 5, maximum: 43200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(43200)
  targetNormalMinutes?: number;

  @ApiPropertyOptional({ minimum: 5, maximum: 43200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(43200)
  targetLowMinutes?: number;
}

/** Gasto mensual estimado del asistente con IA si se consume todo el tope de tokens (US$). */
export class AssistantCostEstimateDto {
  @ApiProperty({
    example: 0.24,
    description:
      'Con el reparto de un chat (95 % entrada, 5 % salida), a los precios de Claude Haiku 5.5. La caché lo puede bajar.',
  })
  min!: number;
  @ApiProperty({ example: 1, description: 'Si todo fuera salida (peor caso)' })
  max!: number;
}

export class SupportSettingsResponseDto {
  @ApiProperty() timezone!: string;
  @ApiProperty({ type: [ChatHoursDto] }) chatHours!: ChatHoursDto[];
  @ApiProperty() chatAckEnabled!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Nulo: el texto de siempre',
  })
  chatAckMessage!: string | null;
  @ApiProperty({
    description: 'El asistente con IA contesta en el chat del soporte',
  })
  assistantAiEnabled!: boolean;
  @ApiProperty({
    minimum: 1,
    maximum: 50,
    description: 'Tope de respuestas del asistente con IA por conversación',
  })
  assistantRepliesPerConversation!: number;
  @ApiProperty({
    minimum: 10000,
    maximum: 1000000000,
    description:
      'Tope de tokens por mes del asistente con IA, por empresa y para el soporte',
  })
  assistantMonthlyTokenLimit!: number;
  @ApiProperty({
    type: AssistantCostEstimateDto,
    description:
      'Lo que costaría por mes (por empresa, y el soporte aparte) consumir todo `assistantMonthlyTokenLimit`, en dólares. Lo calcula el back; el panel lo muestra tal cual.',
  })
  assistantMonthlyCostEstimateUsd!: AssistantCostEstimateDto;
  @ApiProperty() chatInactivityHours!: number;
  @ApiProperty() resolvedCloseDays!: number;
  @ApiProperty() waitingCloseDays!: number;
  @ApiProperty() waitingWarnDays!: number;
  @ApiProperty() targetUrgentMinutes!: number;
  @ApiProperty() targetHighMinutes!: number;
  @ApiProperty() targetNormalMinutes!: number;
  @ApiProperty() targetLowMinutes!: number;
  @ApiProperty({ description: 'Si en este momento se atiende el chat' })
  openNow!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  updatedAt!: string | null;
}

/** Respuesta guardada de la plataforma. */
export class CreateMessageTemplateDto {
  @ApiProperty({
    enum: MessageTemplateScope,
    description:
      '`platform_reply`: respuesta rápida del soporte. `auto_reply`: la automática del chat (clave `fuera_de_horario`).',
  })
  @IsEnum(MessageTemplateScope)
  scope!: MessageTemplateScope;

  @ApiProperty({ example: 'como_cargar_logo', maxLength: 60 })
  @Recortar()
  @Matches(/^[a-z0-9]+(_[a-z0-9]+)*$/)
  @Length(1, 60)
  key!: string;

  @ApiProperty({ example: 'Cargar el logo', minLength: 2, maxLength: 60 })
  @Recortar()
  @IsString()
  @Length(2, 60)
  title!: string;

  @ApiProperty({ minLength: 1, maxLength: 1000 })
  @Recortar()
  @IsString()
  @Length(1, 1000)
  body!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active: boolean = true;
}

/** El alcance y la clave no cambian: se da de baja y se crea otra. */
export class UpdateMessageTemplateDto extends PartialType(
  OmitType(CreateMessageTemplateDto, ['scope', 'key'] as const),
) {}

export class QueryMessageTemplatesDto {
  @ApiPropertyOptional({ enum: MessageTemplateScope })
  @IsOptional()
  @IsEnum(MessageTemplateScope)
  scope?: MessageTemplateScope;
}

export class MessageTemplateResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: MessageTemplateScope }) scope!: MessageTemplateScope;
  @ApiProperty() key!: string;
  @ApiProperty() title!: string;
  @ApiProperty() body!: string;
  @ApiProperty() active!: boolean;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class MessageTemplateListResponseDto {
  @ApiProperty({ type: [MessageTemplateResponseDto] })
  items!: MessageTemplateResponseDto[];
}
