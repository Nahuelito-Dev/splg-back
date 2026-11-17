import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';
import type { DiaSinAtencion } from '../domain/horario-de-la-empresa';
import type { FranjaDeAtencion } from '../domain/horario';

/**
 * Configuración de la bandeja de una empresa (diseño §6.9 y §8.4): su horario
 * de atención (franjas por día y días sin atención, en su zona horaria), si
 * atiende a los clientes por chat, el asistente (su nombre, con el que se
 * firman las respuestas automáticas, y lo que dice al pasar la conversación a
 * una persona), las respuestas automáticas (fuera de horario y aviso de
 * recibido) y el objetivo de primera respuesta. Una fila por
 * empresa; si no existe, valen los valores por defecto.
 *
 * El horario va en listas (como el de la plataforma, `platform_support_settings`)
 * en vez de tablas aparte: es una sola configuración, la valida el DTO (sin
 * solapados ni días repetidos) y la base exige que sean listas.
 */
@Entity('chat_company_settings')
@Check(
  'CHK_chat_company_settings_horario',
  `jsonb_typeof("business_hours") = 'array' AND jsonb_typeof("holidays") = 'array'`,
)
@Check(
  'CHK_chat_company_settings_textos',
  `("out_of_hours_message" IS NULL OR char_length(btrim("out_of_hours_message")) BETWEEN 1 AND 500) AND ("ack_message" IS NULL OR char_length(btrim("ack_message")) BETWEEN 1 AND 500)`,
)
@Check(
  'CHK_chat_company_settings_derivacion',
  `"handoff_message" IS NULL OR char_length(btrim("handoff_message")) BETWEEN 1 AND 500`,
)
@Check(
  'CHK_chat_company_settings_asistente',
  `"assistant_name" IS NULL OR (char_length(btrim("assistant_name")) BETWEEN 2 AND 60 AND "assistant_name" !~ '[\\u0001-\\u001F\\u007F-\\u009F\\u2028\\u2029]')`,
)
@Check(
  'CHK_chat_company_settings_encuesta',
  `"csat_message" IS NULL OR char_length(btrim("csat_message")) BETWEEN 1 AND 500`,
)
@Check(
  'CHK_chat_company_settings_acciones',
  `jsonb_typeof("customer_actions") = 'array' AND "customer_actions" <@ '["where_is_my_order", "repeat_last_order", "payment_methods", "talk_to_person"]'::jsonb`,
)
@Check(
  'CHK_chat_company_settings_objetivo',
  `"first_response_target_minutes" BETWEEN 5 AND 1440`,
)
@Check(
  'CHK_chat_company_settings_inactividad',
  `("inactivity_close_minutes" IS NULL OR "inactivity_close_minutes" BETWEEN 30 AND 10080) AND ("inactivity_warning_minutes" IS NULL OR ("inactivity_close_minutes" IS NOT NULL AND "inactivity_warning_minutes" BETWEEN 5 AND 1440 AND "inactivity_warning_minutes" < "inactivity_close_minutes")) AND ("inactivity_close_minutes" IS NULL) = ("inactivity_enabled_at" IS NULL)`,
)
@Check(
  'CHK_chat_company_settings_asignacion',
  `"auto_assign_max_open" BETWEEN 1 AND 50`,
)
export class ChatCompanySettings {
  @PrimaryColumn({
    name: 'distributor_id',
    type: 'uuid',
    primaryKeyConstraintName: 'PK_chat_company_settings',
  })
  distributorId!: string;

  // RESTRICT: la baja de una empresa es lógica; su configuración queda.
  @OneToOne(() => Distributor, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'distributor_id',
    foreignKeyConstraintName: 'FK_chat_company_settings_distributor',
  })
  distributor?: Distributor;

  @Column({
    type: 'varchar',
    length: 60,
    default: 'America/Argentina/Buenos_Aires',
  })
  timezone!: string;

  /** Franjas de atención; vacía = atiende todo el día. */
  @Column({ name: 'business_hours', type: 'jsonb', default: () => `'[]'` })
  businessHours!: FranjaDeAtencion[];

  /** Días sin atención (feriados, inventario). */
  @Column({ type: 'jsonb', default: () => `'[]'` })
  holidays!: DiaSinAtencion[];

  /** Apagado: los clientes no pueden escribir (C3); los choferes sí (C2). */
  @Column({ name: 'customer_chat_enabled', type: 'boolean', default: true })
  customerChatEnabled!: boolean;

  /**
   * Nombre del asistente, con el que se firman las respuestas automáticas
   * (D-B8). Admite `{{empresa.nombre}}`; nulo: «Asistente de {{empresa.nombre}}».
   */
  @Column({
    name: 'assistant_name',
    type: 'varchar',
    length: 60,
    nullable: true,
  })
  assistantName!: string | null;

  /**
   * El asistente con IA contesta a los clientes (DISENO-CH-BOT B3). Además
   * hace falta que la plataforma le haya habilitado la función. Apagado por
   * omisión.
   */
  @Column({ name: 'assistant_ai_enabled', type: 'boolean', default: false })
  assistantAiEnabled!: boolean;

  /**
   * Lo que dice el asistente al pasar la conversación a una persona (D-B8),
   * con variables; nulo: «Te paso con alguien del equipo de {{empresa.nombre}}…».
   */
  @Column({
    name: 'handoff_message',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  handoffMessage!: string | null;

  /** Respuesta automática al cliente fuera de horario, una por período cerrado. */
  @Column({ name: 'out_of_hours_enabled', type: 'boolean', default: true })
  outOfHoursEnabled!: boolean;

  /** Texto (con variables); nulo: «Ahora estamos fuera de horario. Te respondemos {{horario.proximo}}.» */
  @Column({
    name: 'out_of_hours_message',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  outOfHoursMessage!: string | null;

  /** Aviso de recibido al primer mensaje del cliente en horario (D-C29). */
  @Column({ name: 'ack_enabled', type: 'boolean', default: false })
  ackEnabled!: boolean;

  /** Texto (con variables); nulo: «Recibimos tu mensaje. Alguien del equipo de {{empresa.nombre}} te va a atender a la brevedad.» */
  @Column({
    name: 'ack_message',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  ackMessage!: string | null;

  /** Encuesta de satisfacción al cerrar una conversación con un cliente (4b). Prendida por omisión. */
  @Column({ name: 'csat_enabled', type: 'boolean', default: true })
  csatEnabled!: boolean;

  /** Texto (con variables) del pedido de calificación; nulo: el de omisión (`ENCUESTA_POR_DEFECTO`). */
  @Column({
    name: 'csat_message',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  csatMessage!: string | null;

  /**
   * Los botones de acción que ve el cliente en el chat (4e), del catálogo
   * `ACCIONES_DEL_CLIENTE`. Por omisión, todos; vacía: ninguno.
   */
  @Column({
    name: 'customer_actions',
    type: 'jsonb',
    default: () =>
      `'["where_is_my_order", "repeat_last_order", "payment_methods", "talk_to_person"]'`,
  })
  customerActions!: string[];

  /** Objetivo propio de primera respuesta, en minutos hábiles (para su tablero). */
  @Column({
    name: 'first_response_target_minutes',
    type: 'smallint',
    default: 30,
  })
  firstResponseTargetMinutes!: number;

  /**
   * Mostrar al cliente y al chofer el tiempo de respuesta esperado («Solemos
   * responder en ~N min», tanda 7c). Prendido por omisión.
   */
  @Column({ name: 'expected_reply_enabled', type: 'boolean', default: true })
  expectedReplyEnabled!: boolean;

  /**
   * Cerrar sola la conversación cuando la última respuesta es del equipo o del
   * asistente y la persona no contesta en estos minutos (30 a 10080). Nulo:
   * apagado (por omisión).
   */
  @Column({
    name: 'inactivity_close_minutes',
    type: 'integer',
    nullable: true,
  })
  inactivityCloseMinutes!: number | null;

  /**
   * Minutos antes del cierre en que se avisa «Si no tenés más consultas,
   * cerramos la conversación en N min» (5 a 1440, menos que el cierre). Nulo:
   * cierra sin avisar.
   */
  @Column({
    name: 'inactivity_warning_minutes',
    type: 'integer',
    nullable: true,
  })
  inactivityWarningMinutes!: number | null;

  /**
   * Desde cuándo rigen los plazos de inactividad (se prendió el cierre o se
   * cambió el cierre o el aviso). Lo anterior no cuenta: prenderlo no cierra
   * el atraso de golpe y un aviso anterior no vale. Nulo si está apagado.
   */
  @Column({
    name: 'inactivity_enabled_at',
    type: 'timestamptz',
    nullable: true,
  })
  inactivityEnabledAt!: Date | null;

  /**
   * Asignación automática (tanda 8b): la conversación que queda esperando a
   * una persona se le da sola a alguien del equipo en línea con lugar.
   * Apagada por omisión.
   */
  @Column({ name: 'auto_assign_enabled', type: 'boolean', default: false })
  autoAssignEnabled!: boolean;

  /**
   * Tope de conversaciones abiertas por persona para la asignación
   * automática (1 a 50); cada persona puede tener el suyo.
   */
  @Column({ name: 'auto_assign_max_open', type: 'smallint', default: 5 })
  autoAssignMaxOpen!: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'updated_by_user_id',
    foreignKeyConstraintName: 'FK_chat_company_settings_updated_by',
  })
  updatedBy?: User | null;

  @Column({ name: 'updated_by_user_id', type: 'uuid', nullable: true })
  updatedByUserId!: string | null;
}
