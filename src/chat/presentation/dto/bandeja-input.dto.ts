import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDefined,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  LARGO_DESCRIPCION,
  LARGO_MOTIVO_DE_RECLAMO,
} from '../../../common/constants/largos-de-texto';
import { TextoNoVacio } from '../../../common/decorators/texto-no-vacio.decorator';
import { TOPE_DE_CHOFERES_POR_ENVIO } from '../../domain/bandeja';
import {
  Channel,
  ConversationStatus,
  SubjectType,
} from '../../domain/chat.enums';
import { ChatPaginationDto } from './chat-input.dto';
import { ChatHoursDto } from './support-settings.dto';

const Recortar = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

const ABooleano = () =>
  Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  );

/** Los canales de la bandeja, para Swagger y la validación. */
const CANALES = [Channel.STAFF_CUSTOMER, Channel.STAFF_DRIVER] as const;
const AMBITOS = [SubjectType.GENERAL, SubjectType.ORDER] as const;

/**
 * Un mensaje de la bandeja (clientes, choferes y personal). Reintentar con el
 * mismo `clientMessageId` no lo duplica (200 con el ya guardado).
 */
export class SendInboxMessageDto {
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
    example: '¿A qué hora llega el pedido?',
  })
  @Recortar()
  @IsString()
  @Length(1, 2000)
  body!: string;

  @ApiPropertyOptional({
    minimum: 1,
    description:
      'Responder a un mensaje (D-C25): el `seq` de un mensaje anterior de la MISMA conversación. Uno que no existe ahí → 400 `REPLY_TO_INVALID`.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  replyToSeq?: number;
}

/**
 * Un mensaje del personal: el texto o una respuesta guardada de la empresa
 * (`templateId`), que el back completa con sus variables. Exactamente uno de
 * los dos.
 */
export class SendStaffMessageDto extends OmitType(SendInboxMessageDto, [
  'body',
] as const) {
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 2000,
    description: 'El texto. Obligatorio si no viene `templateId`.',
  })
  @ValidateIf((o: SendStaffMessageDto) => o.templateId === undefined)
  @Recortar()
  @IsString({ message: 'Escribí el mensaje o elegí una respuesta guardada' })
  @Length(1, 2000)
  body?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Una respuesta guardada activa de la empresa para este canal: el back completa `{{cliente.nombre}}`, `{{pedido.numero}}`, `{{empresa.nombre}}` y `{{horario.proximo}}`. No va junto con `body`.',
  })
  @ValidateIf(
    (o: SendStaffMessageDto) =>
      o.templateId !== undefined || o.body === undefined,
  )
  @IsUUID('4', {
    message: 'Escribí el mensaje o elegí una respuesta guardada, no las dos',
  })
  templateId?: string;
}

/** Editar el texto de un mensaje propio (D-C22), hasta 15 minutos después de enviarlo. */
export class EditMessageDto {
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @Recortar()
  @IsString()
  @Length(1, 2000)
  body!: string;
}

/** Abrir (o seguir) una conversación desde la app del cliente o del chofer. */
export class OpenMyConversationDto {
  @ApiProperty({
    enum: AMBITOS,
    description:
      '`general`: con la empresa (una abierta por persona: si ya hay una, se agrega el mensaje y responde 200). `order`: por un pedido propio (`orderId`).',
  })
  @IsIn(AMBITOS)
  subjectType!: SubjectType.GENERAL | SubjectType.ORDER;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Obligatorio con `order`; no va con `general`',
  })
  @ValidateIf((o: OpenMyConversationDto) => o.subjectType === SubjectType.ORDER)
  @IsUUID('4', { message: 'Elegí el pedido' })
  orderId?: string;

  @ApiProperty({ type: SendInboxMessageDto })
  @IsDefined({ message: 'Falta el primer mensaje' })
  @ValidateNested()
  @Type(() => SendInboxMessageDto)
  firstMessage!: SendInboxMessageDto;
}

/** Abrir (o seguir) una conversación desde el panel, con un cliente o con un chofer. */
export class OpenStaffConversationDto {
  @ApiProperty({
    enum: CANALES,
    description:
      '`staff_customer`: con un cliente. `staff_driver`: con un chofer.',
  })
  @IsIn(CANALES)
  channel!: Channel.STAFF_CUSTOMER | Channel.STAFF_DRIVER;

  @ApiProperty({ enum: AMBITOS })
  @IsIn(AMBITOS)
  subjectType!: SubjectType.GENERAL | SubjectType.ORDER;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'El usuario del cliente (`staff_customer` general). Con `order` sale del pedido.',
  })
  @IsOptional()
  @IsUUID('4')
  customerId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'El usuario del chofer (`staff_driver` general). Con `order` sale del pedido (el chofer asignado).',
  })
  @IsOptional()
  @IsUUID('4')
  driverId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Obligatorio con `order`; no va con `general`',
  })
  @ValidateIf(
    (o: OpenStaffConversationDto) => o.subjectType === SubjectType.ORDER,
  )
  @IsUUID('4', { message: 'Elegí el pedido' })
  orderId?: string;

  @ApiProperty({ type: SendStaffMessageDto })
  @IsDefined({ message: 'Falta el primer mensaje' })
  @ValidateNested()
  @Type(() => SendStaffMessageDto)
  firstMessage!: SendStaffMessageDto;
}

/** Un mismo mensaje a varios choferes: uno en la conversación general de cada uno (§4.4). */
export class BroadcastDriversDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: TOPE_DE_CHOFERES_POR_ENVIO,
    description:
      'Usuarios de los choferes, sin repetir. Si alguno no es de la empresa → 404 y no se manda a ninguno.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TOPE_DE_CHOFERES_POR_ENVIO)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  driverIds!: string[];

  @ApiProperty({
    minLength: 1,
    maxLength: 2000,
    example: 'Hoy cerramos a las 18.',
  })
  @Recortar()
  @IsString()
  @Length(1, 2000)
  body!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'Lo genera el panel. Repetir el envío con el mismo id no duplica los mensajes.',
  })
  @IsUUID('4')
  clientBatchId!: string;
}

export class AssignConversationDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Alguien del personal de la empresa que atienda este canal; `null` la devuelve a la cola.',
  })
  @ValidateIf((o: AssignConversationDto) => o.userId !== null)
  @IsUUID('4')
  userId!: string | null;
}

/** Crear un reclamo desde una conversación con un cliente. */
export class CreateClaimFromConversationDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'El pedido reclamado, del mismo cliente. En una conversación por pedido se usa ése (si viene, tiene que ser el mismo).',
  })
  @IsOptional()
  @IsUUID('4')
  orderId?: string;

  @ApiProperty({
    maxLength: LARGO_MOTIVO_DE_RECLAMO,
    example: 'Pérdida de gas',
  })
  @TextoNoVacio()
  @MaxLength(LARGO_MOTIVO_DE_RECLAMO)
  reason!: string;

  @ApiProperty({ maxLength: LARGO_DESCRIPCION })
  @TextoNoVacio()
  @MaxLength(LARGO_DESCRIPCION)
  description!: string;
}

/** `me` (las mías), `none` (sin asignar) o el id de alguien del personal. */
const ASIGNADO =
  /^(me|none|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Filtros de la bandeja del panel. */
export class QueryInboxDto extends ChatPaginationDto {
  @ApiPropertyOptional({
    enum: CANALES,
    description:
      'Sin él, los canales que atiende quien pide. Uno que no atiende → 403.',
  })
  @IsOptional()
  @IsIn(CANALES)
  channel?: Channel.STAFF_CUSTOMER | Channel.STAFF_DRIVER;

  @ApiPropertyOptional({
    enum: ConversationStatus,
    description: 'Sin él, abiertas y cerradas',
  })
  @IsOptional()
  @IsEnum(ConversationStatus)
  status?: ConversationStatus;

  @ApiPropertyOptional({
    description:
      '`me` (las mías), `none` (sin asignar) o el id de alguien del personal',
  })
  @IsOptional()
  @Matches(ASIGNADO)
  assigned?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Usuario del cliente' })
  @IsOptional()
  @IsUUID('4')
  customerId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Usuario del chofer' })
  @IsOptional()
  @IsUUID('4')
  driverId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  orderId?: string;

  @ApiPropertyOptional({
    minLength: 3,
    maxLength: 100,
    description: 'Nombre del cliente o del chofer, o texto del último mensaje',
  })
  @IsOptional()
  @Recortar()
  @IsString()
  @Length(3, 100)
  q?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Sólo las que cambiaron después (reconexión)',
  })
  @IsOptional()
  @Type(() => Date)
  updatedSince?: Date;
}

/** Filtros de «mis conversaciones» de la app. */
export class QueryMyConversationsDto extends ChatPaginationDto {
  @ApiPropertyOptional({ enum: ConversationStatus })
  @IsOptional()
  @IsEnum(ConversationStatus)
  status?: ConversationStatus;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Sólo las que cambiaron después (reconexión)',
  })
  @IsOptional()
  @Type(() => Date)
  updatedSince?: Date;
}

/** Parámetros de la bandeja: lo que no viene queda como estaba. */
export class UpdateChatSettingsDto {
  @ApiPropertyOptional({
    description:
      'Apagado: los clientes no pueden abrir ni escribir (C3); los choferes sí.',
  })
  @IsOptional()
  @IsBoolean()
  customerChatEnabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Responder automáticamente al cliente fuera de horario (una vez por período cerrado)',
  })
  @IsOptional()
  @IsBoolean()
  outOfHoursEnabled?: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 500,
    description:
      'Texto de la respuesta fuera de horario, con variables; `null`: «Ahora estamos fuera de horario. Te respondemos {{horario.proximo}}.»',
  })
  @IsOptional()
  @Recortar()
  @ValidateIf((o: UpdateChatSettingsDto) => o.outOfHoursMessage !== null)
  @IsString()
  @Length(1, 500)
  outOfHoursMessage?: string | null;

  @ApiPropertyOptional({
    description:
      'Aviso automático al primer mensaje del cliente en horario, si nadie de la empresa escribió todavía',
  })
  @IsOptional()
  @IsBoolean()
  ackEnabled?: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 500,
    description:
      'Texto del aviso, con variables; `null`: «Recibimos tu mensaje. Alguien del equipo de {{empresa.nombre}} te va a atender a la brevedad.»',
  })
  @IsOptional()
  @Recortar()
  @ValidateIf((o: UpdateChatSettingsDto) => o.ackMessage !== null)
  @IsString()
  @Length(1, 500)
  ackMessage?: string | null;

  @ApiPropertyOptional({
    minimum: 5,
    maximum: 1440,
    description: 'Objetivo propio de primera respuesta, en minutos hábiles',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(1440)
  firstResponseTargetMinutes?: number;
}

/** Un día sin atención (feriado, inventario). */
export class ChatHolidayDto {
  @ApiProperty({
    example: '2026-12-25',
    description: 'Fecha local de la empresa',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'La fecha va como AAAA-MM-DD' })
  date!: string;

  @ApiProperty({ minLength: 2, maxLength: 120, example: 'Navidad' })
  @Recortar()
  @IsString()
  @Length(2, 120)
  reason!: string;
}

/** Horario de atención del chat de la empresa: lo que no viene queda como estaba. */
export class UpdateChatBusinessHoursDto {
  @ApiPropertyOptional({ example: 'America/Argentina/Buenos_Aires' })
  @IsOptional()
  @Recortar()
  @IsString()
  @Length(3, 60)
  timezone?: string;

  @ApiPropertyOptional({
    type: [ChatHoursDto],
    description:
      'Franjas de atención por día (sin solaparse en el mismo día). Vacía: atiende todo el día.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(28)
  @ValidateNested({ each: true })
  @Type(() => ChatHoursDto)
  days?: ChatHoursDto[];

  @ApiPropertyOptional({
    type: [ChatHolidayDto],
    description: 'Días sin atención (sin repetir la fecha)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ChatHolidayDto)
  holidays?: ChatHolidayDto[];
}

/** Una respuesta guardada de la empresa. */
export class CreateCompanyTemplateDto {
  @ApiPropertyOptional({
    enum: CANALES,
    nullable: true,
    description: 'El canal en que se ofrece; sin él, en los dos',
  })
  @IsOptional()
  @IsIn(CANALES)
  channel?: Channel.STAFF_CUSTOMER | Channel.STAFF_DRIVER;

  @ApiProperty({
    pattern: '^[a-z0-9]+(_[a-z0-9]+)*$',
    maxLength: 60,
    example: 'pedido_en_camino',
  })
  @Matches(/^[a-z0-9]+(_[a-z0-9]+)*$/, {
    message: 'La clave va en minúsculas, números y guiones bajos',
  })
  @Length(2, 60)
  key!: string;

  @ApiProperty({ minLength: 2, maxLength: 60, example: 'Pedido en camino' })
  @Recortar()
  @IsString()
  @Length(2, 60)
  title!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 1000,
    example: 'Hola {{cliente.nombre}}, tu pedido {{pedido.numero}} ya salió.',
    description:
      'Variables: `{{cliente.nombre}}`, `{{pedido.numero}}`, `{{empresa.nombre}}`, `{{horario.proximo}}`. Otra → 400 `TEMPLATE_VARIABLE_UNKNOWN`.',
  })
  @Recortar()
  @IsString()
  @Length(1, 1000)
  body!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active: boolean = true;
}

export class UpdateCompanyTemplateDto extends PartialType(
  OmitType(CreateCompanyTemplateDto, ['active'] as const),
) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class QueryCompanyTemplatesDto {
  @ApiPropertyOptional({
    enum: CANALES,
    description: 'Las de ese canal y las de los dos',
  })
  @IsOptional()
  @IsIn(CANALES)
  channel?: Channel.STAFF_CUSTOMER | Channel.STAFF_DRIVER;

  @ApiPropertyOptional()
  @IsOptional()
  @ABooleano()
  @IsBoolean()
  active?: boolean;
}
