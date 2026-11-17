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
  IsDate,
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
  ValidateBy,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  LARGO_DESCRIPCION,
  LARGO_MOTIVO_DE_RECLAMO,
} from '../../../common/constants/largos-de-texto';
import { TextoNoVacio } from '../../../common/decorators/texto-no-vacio.decorator';
import {
  nombreDelAsistenteValido,
  TOPE_DE_CHOFERES_POR_ENVIO,
} from '../../domain/bandeja';
import { TOPE_DE_MENCIONES } from '../../domain/notas-internas';
import {
  ESTADOS_DEL_AGENTE,
  type EstadoDelAgente,
  TOPE_MAXIMO,
  TOPE_MINIMO,
} from '../../domain/asignacion-automatica';
import {
  COLORES_DE_ETIQUETA,
  type ColorDeEtiqueta,
  LARGO_DEL_NOMBRE_DE_ETIQUETA,
  nombreDeEtiquetaValido,
  TOPE_DE_ETIQUETAS_POR_CONVERSACION,
} from '../../domain/etiquetas';
import {
  MINUTOS_DE_AVISO_MAXIMOS,
  MINUTOS_DE_AVISO_MINIMOS,
  MINUTOS_DE_INACTIVIDAD_MAXIMOS,
  MINUTOS_DE_INACTIVIDAD_MINIMOS,
} from '../../domain/inactividad';
import {
  CLAVES_DE_ACCION,
  type ClaveDeAccion,
} from '../../domain/acciones-del-cliente';
import { LARGO_DEL_COMENTARIO } from '../../domain/encuesta';
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

/**
 * Una nota interna del personal en la bandeja (4a): sólo la ve el personal de
 * la empresa. `mentions` son los ids de usuario de las personas mencionadas
 * (el panel arma el `@Nombre` en el texto); tienen que atender este canal.
 */
export class SendInternalNoteDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Lo genera quien escribe. El mismo id repetido devuelve la nota ya guardada (200) sin duplicarla ni volver a avisar.',
  })
  @IsUUID('4')
  clientMessageId!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 2000,
    example: '@Juan fijate si el chofer pasó por la casa',
  })
  @Recortar()
  @IsString()
  @Length(1, 2000)
  body!: string;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: TOPE_DE_MENCIONES,
    uniqueItems: true,
    description: `Ids de usuario de las personas del personal que se mencionan (hasta ${TOPE_DE_MENCIONES}, sin repetir). Cada una tiene que atender el canal de la conversación (la misma regla que \`assignees\`); si no → 400 \`MENTION_NOT_ALLOWED\`.`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TOPE_DE_MENCIONES)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  mentions?: string[];
}

/** Marcar leídas las menciones a quien pide en una conversación. */
export class MarkMentionsReadDto {
  @ApiPropertyOptional({
    minimum: 1,
    description:
      'Hasta la nota con ese `seq` (inclusive); sin él, todas las de la conversación',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  upToSeq?: number;
}

/** Editar el texto de un mensaje propio (D-C22), hasta 15 minutos después de enviarlo. */
export class EditMessageDto {
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @Recortar()
  @IsString()
  @Length(1, 2000)
  body!: string;
}

/** Tocar un botón de acción del chat (4e). */
export class SendCustomerActionDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Lo genera la app. El mismo id repetido devuelve el mensaje ya guardado (200).',
  })
  @IsUUID('4')
  clientMessageId!: string;

  @ApiProperty({ enum: CLAVES_DE_ACCION })
  @IsIn(CLAVES_DE_ACCION)
  key!: ClaveDeAccion;
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

  @ApiPropertyOptional({
    type: SendInboxMessageDto,
    description:
      'El primer mensaje. Va esto o `firstAction`, uno de los dos (ninguno o los dos → 400).',
  })
  @ValidateIf(
    (o: OpenMyConversationDto) =>
      o.firstMessage !== undefined || o.firstAction === undefined,
  )
  @IsDefined({ message: 'Escribí el primer mensaje o tocá una opción' })
  @ValidateNested()
  @Type(() => SendInboxMessageDto)
  firstMessage?: SendInboxMessageDto;

  @ApiPropertyOptional({
    type: SendCustomerActionDto,
    description:
      'Sólo el cliente (4e): abrir el chat tocando un botón de acción (`GET /v2/me/conversations/actions`). Se manda su texto predefinido como primer mensaje; `talk_to_person` además la deja esperando a una persona (el asistente no la toma). La de la app → 400 `ACTION_IS_APP_ONLY`; una que la empresa no muestra → 400 `ACTION_NOT_AVAILABLE`; el chofer → 403 `CUSTOMER_ONLY`. No va junto con `firstMessage`.',
  })
  @ValidateIf((o: OpenMyConversationDto) => o.firstAction !== undefined)
  @ValidateBy({
    name: 'unoSolo',
    validator: {
      validate: (_v: unknown, a) =>
        (a?.object as OpenMyConversationDto).firstMessage === undefined,
      defaultMessage: () =>
        'Escribí el primer mensaje o tocá una opción, no las dos cosas',
    },
  })
  @ValidateNested()
  @Type(() => SendCustomerActionDto)
  firstAction?: SendCustomerActionDto;
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

  @ApiPropertyOptional({
    type: Boolean,
    description:
      '`true`: sólo las que esperan a una persona (el asistente con IA las derivó); `false`: sólo las que no. Con `assigned=none`, las que esperan van primero (la que espera hace más, primero).',
  })
  @IsOptional()
  @ABooleano()
  @IsBoolean()
  awaiting?: boolean;

  @ApiPropertyOptional({
    enum: ['me', 'unread'],
    description:
      'Vista «Me mencionaron»: `me`, las conversaciones con alguna nota que menciona a quien pide; `unread`, sólo las que tienen alguna mención sin leer.',
  })
  @IsOptional()
  @IsIn(['me', 'unread'])
  mentioned?: 'me' | 'unread';

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

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Sólo las que tienen esa etiqueta (vigente). Una etiqueta de otra empresa no trae nada.',
  })
  @IsOptional()
  @IsUUID('4', { message: 'Elegí una etiqueta de la lista' })
  labelId?: string;
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
    type: String,
    nullable: true,
    minLength: 2,
    maxLength: 60,
    example: 'Asistente de {{empresa.nombre}}',
    description:
      'Nombre del asistente, con el que se firman las respuestas automáticas: de 2 a 60 caracteres (contados como letras, no en UTF-16) en una sola línea (sin saltos ni separadores de línea, U+2028/U+2029). Sólo admite `{{empresa.nombre}}` (otra → 400 `TEMPLATE_VARIABLE_UNKNOWN`); `null`: «Asistente de {{empresa.nombre}}».',
  })
  @IsOptional()
  @Recortar()
  @ValidateIf((o: UpdateChatSettingsDto) => o.assistantName !== null)
  @IsString()
  @ValidateBy({
    name: 'nombreDelAsistente',
    validator: {
      validate: (v: unknown) =>
        typeof v === 'string' && nombreDelAsistenteValido(v),
      defaultMessage: () =>
        'El nombre del asistente tiene que tener entre 2 y 60 caracteres, en una sola línea',
    },
  })
  assistantName?: string | null;

  @ApiPropertyOptional({
    description:
      'El asistente con IA contesta a los clientes en el chat (y pasa la conversación a una persona cuando no puede resolver). Prenderlo sin la función habilitada para la empresa → 403 `MODULE_DISABLED`; apagarlo siempre se puede.',
  })
  // `null` no es «no cambiar»: es inválido (la columna no admite nulo).
  @ValidateIf((o: UpdateChatSettingsDto) => o.assistantAiEnabled !== undefined)
  @IsBoolean()
  assistantAiEnabled?: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 500,
    description:
      'Lo que dice el asistente al pasar la conversación a una persona, con variables; `null`: «Te paso con alguien del equipo de {{empresa.nombre}}. Te va a responder a la brevedad.»',
  })
  @IsOptional()
  @Recortar()
  @ValidateIf((o: UpdateChatSettingsDto) => o.handoffMessage !== null)
  @IsString()
  @Length(1, 500)
  handoffMessage?: string | null;

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
    description:
      'Encuesta de satisfacción (1 a 5) al cerrar una conversación con un cliente (prendida por omisión)',
  })
  @ValidateIf((o: UpdateChatSettingsDto) => o.csatEnabled !== undefined)
  @IsBoolean()
  csatEnabled?: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 500,
    description:
      'Texto del pedido de calificación, con variables; `null`: «¿Cómo te atendimos en {{empresa.nombre}}? Tocá de 1 a 5 para calificar la conversación.»',
  })
  @IsOptional()
  @Recortar()
  @ValidateIf((o: UpdateChatSettingsDto) => o.csatMessage !== null)
  @IsString()
  @Length(1, 500)
  csatMessage?: string | null;

  @ApiPropertyOptional({
    type: [String],
    enum: CLAVES_DE_ACCION,
    uniqueItems: true,
    description:
      'Los botones de acción que ve el cliente en el chat, sin repetir: `where_is_my_order`, `repeat_last_order` (la abre la app), `payment_methods`, `talk_to_person`. Vacía: ninguno.',
  })
  @ValidateIf((o: UpdateChatSettingsDto) => o.customerActions !== undefined)
  @IsArray()
  @ArrayMaxSize(CLAVES_DE_ACCION.length)
  @ArrayUnique()
  @IsIn(CLAVES_DE_ACCION, { each: true })
  customerActions?: ClaveDeAccion[];

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

  @ApiPropertyOptional({
    description:
      'Mostrar al cliente y al chofer el tiempo de respuesta esperado («Solemos responder en ~N min»; prendido por omisión)',
  })
  @ValidateIf(
    (o: UpdateChatSettingsDto) => o.expectedReplyEnabled !== undefined,
  )
  @IsBoolean()
  expectedReplyEnabled?: boolean;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: MINUTOS_DE_INACTIVIDAD_MINIMOS,
    maximum: MINUTOS_DE_INACTIVIDAD_MAXIMOS,
    description:
      'Cerrar sola la conversación si la última respuesta es del equipo o del asistente y el cliente o el chofer no contesta en estos minutos (30 a 10080). `null`: no se cierra sola (por omisión). Apagarlo apaga también el aviso.',
  })
  @IsOptional()
  @ValidateIf((o: UpdateChatSettingsDto) => o.inactivityCloseMinutes !== null)
  @IsInt({
    message: 'Los minutos para cerrar por inactividad van en número entero',
  })
  @Min(MINUTOS_DE_INACTIVIDAD_MINIMOS, {
    message:
      'El cierre por inactividad va de 30 minutos a 7 días (10080 minutos)',
  })
  @Max(MINUTOS_DE_INACTIVIDAD_MAXIMOS, {
    message:
      'El cierre por inactividad va de 30 minutos a 7 días (10080 minutos)',
  })
  inactivityCloseMinutes?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: MINUTOS_DE_AVISO_MINIMOS,
    maximum: MINUTOS_DE_AVISO_MAXIMOS,
    description:
      'Minutos antes del cierre en que se avisa «Si no tenés más consultas, cerramos la conversación en N min» (5 a 1440 y menos que `inactivityCloseMinutes`). `null`: cierra sin avisar.',
  })
  @IsOptional()
  @ValidateIf((o: UpdateChatSettingsDto) => o.inactivityWarningMinutes !== null)
  @IsInt({ message: 'Los minutos del aviso van en número entero' })
  @Min(MINUTOS_DE_AVISO_MINIMOS, {
    message: 'El aviso va de 5 minutos a 24 horas antes del cierre',
  })
  @Max(MINUTOS_DE_AVISO_MAXIMOS, {
    message: 'El aviso va de 5 minutos a 24 horas antes del cierre',
  })
  inactivityWarningMinutes?: number | null;

  @ApiPropertyOptional({
    description:
      'Asignación automática (8b): la conversación que queda esperando a una persona se le da sola a alguien del equipo en línea con lugar. Prenderla reparte enseguida lo que esté esperando.',
  })
  // `null` no es «no cambiar»: es inválido (la columna no admite nulo).
  @ValidateIf((o: UpdateChatSettingsDto) => o.autoAssignEnabled !== undefined)
  @IsBoolean()
  autoAssignEnabled?: boolean;

  @ApiPropertyOptional({
    minimum: TOPE_MINIMO,
    maximum: TOPE_MAXIMO,
    description:
      'Tope de conversaciones abiertas por persona para la asignación automática (1 a 50); cada persona puede tener el suyo. Subirlo reparte enseguida lo que esté esperando.',
  })
  @ValidateIf((o: UpdateChatSettingsDto) => o.autoAssignMaxOpen !== undefined)
  @IsInt({ message: 'El tope de conversaciones abiertas va en número entero' })
  @Min(TOPE_MINIMO, {
    message: 'El tope de conversaciones abiertas por persona va de 1 a 50',
  })
  @Max(TOPE_MAXIMO, {
    message: 'El tope de conversaciones abiertas por persona va de 1 a 50',
  })
  autoAssignMaxOpen?: number;
}

/** Ponerse en línea o ausente en la bandeja (8b). */
export class UpdateMyChatStatusDto {
  @ApiProperty({
    enum: ESTADOS_DEL_AGENTE,
    description:
      '`online`: recibe conversaciones por asignación automática (si está conectada al panel y la empresa atiende); `away`: no recibe.',
  })
  @IsIn(ESTADOS_DEL_AGENTE)
  status!: EstadoDelAgente;
}

/** El tope propio de una persona del equipo (8b). */
export class UpdateChatAgentDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: TOPE_MINIMO,
    maximum: TOPE_MAXIMO,
    description:
      'Tope propio de conversaciones abiertas (1 a 50); `null` vuelve al de la empresa. Es obligatorio mandarlo.',
  })
  @ValidateIf((o: UpdateChatAgentDto) => o.maxOpenOverride !== null)
  @IsInt({ message: 'El tope de conversaciones abiertas va en número entero' })
  @Min(TOPE_MINIMO, {
    message: 'El tope de conversaciones abiertas por persona va de 1 a 50',
  })
  @Max(TOPE_MAXIMO, {
    message: 'El tope de conversaciones abiertas por persona va de 1 a 50',
  })
  maxOpenOverride!: number | null;
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

/** La respuesta del cliente a la encuesta de satisfacción (4b): un toque y, si quiere, un comentario. */
export class RateConversationDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'La encuesta que se responde: el `ratingId` del `payload` de su mensaje `csat_request` (cada cierre tiene la suya). De otra conversación o de otra persona → 404.',
  })
  @IsUUID('4')
  ratingId!: string;

  @ApiProperty({ minimum: 1, maximum: 5, example: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  score!: number;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: LARGO_DEL_COMENTARIO,
    example: 'Muy rápido, gracias',
  })
  @IsOptional()
  @Recortar()
  @IsString()
  @Length(1, LARGO_DEL_COMENTARIO)
  comment?: string;
}

/** El período del resumen de la encuesta (4b, lectura para B4). */
export class QueryCsatDto {
  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Desde (por pedido de la encuesta); sin él, los últimos 30 días',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Hasta; sin él, ahora. No puede ser anterior a `from` (400).',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  @ValidateBy({
    name: 'hastaDespuesDeDesde',
    validator: {
      validate: (v: unknown, a) => {
        const desde = (a?.object as QueryCsatDto).from;
        return !(v instanceof Date && desde instanceof Date) || desde <= v;
      },
      defaultMessage: () => '«Desde» no puede ser posterior a «hasta»',
    },
  })
  to?: Date;
}

const NOMBRE_DE_ETIQUETA_INVALIDO =
  'El nombre de la etiqueta tiene que tener entre 1 y 30 caracteres, en una sola línea';

/** Una etiqueta nueva de la bandeja (7c). */
export class CreateChatLabelDto {
  @ApiProperty({
    minLength: 1,
    maxLength: LARGO_DEL_NOMBRE_DE_ETIQUETA,
    example: 'Reclamo de envío',
    description:
      'De 1 a 30 caracteres en una sola línea (los espacios de más se recortan). Único entre las vigentes de la empresa sin distinguir mayúsculas ni tildes.',
  })
  @IsString({ message: NOMBRE_DE_ETIQUETA_INVALIDO })
  @ValidateBy({
    name: 'nombreDeEtiqueta',
    validator: {
      validate: (v: unknown) =>
        typeof v === 'string' && nombreDeEtiquetaValido(v),
      defaultMessage: () => NOMBRE_DE_ETIQUETA_INVALIDO,
    },
  })
  name!: string;

  @ApiProperty({ enum: COLORES_DE_ETIQUETA, example: 'orange' })
  @IsIn(COLORES_DE_ETIQUETA, { message: 'Elegí un color de la lista' })
  color!: ColorDeEtiqueta;
}

/**
 * Cambiar una etiqueta: lo que no viene queda como estaba. `null` no es «no
 * cambiar»: es inválido (las columnas no admiten nulo), por eso `ValidateIf`
 * y no `IsOptional`.
 */
export class UpdateChatLabelDto {
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: LARGO_DEL_NOMBRE_DE_ETIQUETA,
    example: 'Reclamo de envío',
  })
  @ValidateIf((o: UpdateChatLabelDto) => o.name !== undefined)
  @IsString({ message: NOMBRE_DE_ETIQUETA_INVALIDO })
  @ValidateBy({
    name: 'nombreDeEtiqueta',
    validator: {
      validate: (v: unknown) =>
        typeof v === 'string' && nombreDeEtiquetaValido(v),
      defaultMessage: () => NOMBRE_DE_ETIQUETA_INVALIDO,
    },
  })
  name?: string;

  @ApiPropertyOptional({ enum: COLORES_DE_ETIQUETA, example: 'orange' })
  @ValidateIf((o: UpdateChatLabelDto) => o.color !== undefined)
  @IsIn(COLORES_DE_ETIQUETA, { message: 'Elegí un color de la lista' })
  color?: ColorDeEtiqueta;
}

/** Las etiquetas que quedan puestas en una conversación (reemplaza las que tenía). */
export class SetConversationLabelsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    maxItems: TOPE_DE_ETIQUETAS_POR_CONVERSACION,
    uniqueItems: true,
    description:
      'Las etiquetas vigentes de la empresa que quedan puestas, sin repetir (hasta 5). Vacía: le saca todas.',
  })
  @IsArray({
    message: 'Mandá la lista de etiquetas (vacía para sacarlas todas)',
  })
  @ArrayMaxSize(TOPE_DE_ETIQUETAS_POR_CONVERSACION, {
    message: 'Una conversación lleva hasta 5 etiquetas',
  })
  @ArrayUnique({ message: 'Hay etiquetas repetidas' })
  @IsUUID('4', { each: true, message: 'Elegí etiquetas de la lista' })
  labelIds!: string[];
}
