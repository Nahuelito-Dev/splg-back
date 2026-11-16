import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import type { FranjaDeAtencion } from '../domain/horario';

/**
 * Configuración del soporte de la plataforma (diseño §6.7, proceso de
 * plataforma): horario del chat, objetivos de primera respuesta por prioridad
 * y plazos de los cierres automáticos. Una sola fila (`settings_id = 1`); si
 * no existe, valen los valores por defecto.
 *
 * El horario va en una lista (`chat_hours`) en vez de una tabla aparte: es una
 * sola configuración, la valida el DTO (sin solapados) y la base exige que sea
 * una lista.
 */
@Entity('platform_support_settings')
@Check('CHK_platform_support_settings_unica', `"settings_id" = 1`)
@Check(
  'CHK_platform_support_settings_horario',
  `jsonb_typeof("chat_hours") = 'array'`,
)
@Check(
  'CHK_platform_support_settings_aviso',
  `"chat_ack_message" IS NULL OR char_length(btrim("chat_ack_message")) BETWEEN 1 AND 500`,
)
@Check(
  'CHK_platform_support_settings_inactividad',
  `"chat_inactivity_hours" BETWEEN 1 AND 168`,
)
@Check(
  'CHK_platform_support_settings_plazos',
  `"resolved_close_days" BETWEEN 1 AND 30 AND "waiting_close_days" BETWEEN 2 AND 30 AND "waiting_warn_days" >= 1 AND "waiting_warn_days" < "waiting_close_days"`,
)
@Check(
  'CHK_platform_support_settings_objetivos',
  `"target_urgent_minutes" BETWEEN 5 AND 43200 AND "target_high_minutes" BETWEEN 5 AND 43200 AND "target_normal_minutes" BETWEEN 5 AND 43200 AND "target_low_minutes" BETWEEN 5 AND 43200`,
)
@Check(
  'CHK_platform_support_settings_asistente',
  `"assistant_replies_per_conversation" BETWEEN 1 AND 50 AND "assistant_monthly_token_limit" BETWEEN 10000 AND 1000000000`,
)
@Check(
  'CHK_platform_support_settings_cupo_por_empresa',
  `"assistant_monthly_token_limit_per_company" BETWEEN 10000 AND 1000000000 AND "assistant_monthly_token_limit_per_company" <= "assistant_monthly_token_limit"`,
)
export class PlatformSupportSettings {
  @PrimaryColumn({
    name: 'settings_id',
    type: 'smallint',
    primaryKeyConstraintName: 'PK_platform_support_settings',
  })
  settingsId!: number;

  @Column({
    type: 'varchar',
    length: 60,
    default: 'America/Argentina/Buenos_Aires',
  })
  timezone!: string;

  /** Franjas de atención del chat; vacía = atiende siempre. */
  @Column({ name: 'chat_hours', type: 'jsonb', default: () => `'[]'` })
  chatHours!: FranjaDeAtencion[];

  /** Aviso automático al primer mensaje de la empresa en horario (D-C29). */
  @Column({ name: 'chat_ack_enabled', type: 'boolean', default: true })
  chatAckEnabled!: boolean;

  /** Texto del aviso; nulo: «Recibimos tu mensaje. Alguien del equipo de <plataforma> te va a atender a la brevedad.» */
  @Column({
    name: 'chat_ack_message',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  chatAckMessage!: string | null;

  /** El asistente con IA contesta a las empresas en el chat del soporte (C1, DISENO-CH-BOT B3). */
  @Column({ name: 'assistant_ai_enabled', type: 'boolean', default: false })
  assistantAiEnabled!: boolean;

  /** Tope de respuestas del asistente con IA por conversación, en C1 y en C3 (§6). */
  @Column({
    name: 'assistant_replies_per_conversation',
    type: 'smallint',
    default: 10,
  })
  assistantRepliesPerConversation!: number;

  /**
   * Tope mensual de tokens del asistente con IA (§6): para cada empresa (C3,
   * sus clientes) y para el soporte de la plataforma (C1). Al pasarlo, sólo
   * la capa fija y derivar.
   */
  @Column({
    name: 'assistant_monthly_token_limit',
    type: 'integer',
    default: 2000000,
  })
  assistantMonthlyTokenLimit!: number;

  /**
   * Cupo mensual de tokens del asistente con IA de cada empresa en el
   * soporte (C1), dentro del tope de la plataforma: al pasarlo, esa empresa
   * recibe sólo la capa fija y derivar; las demás siguen con la IA. Nunca
   * más que el total (`CHK_platform_support_settings_cupo_por_empresa`); por
   * omisión, igual al total por omisión (no recorta a nadie).
   */
  @Column({
    name: 'assistant_monthly_token_limit_per_company',
    type: 'integer',
    default: 2000000,
  })
  assistantMonthlyTokenLimitPerCompany!: number;

  @Column({ name: 'chat_inactivity_hours', type: 'smallint', default: 24 })
  chatInactivityHours!: number;

  @Column({ name: 'resolved_close_days', type: 'smallint', default: 7 })
  resolvedCloseDays!: number;

  @Column({ name: 'waiting_close_days', type: 'smallint', default: 7 })
  waitingCloseDays!: number;

  @Column({ name: 'waiting_warn_days', type: 'smallint', default: 5 })
  waitingWarnDays!: number;

  @Column({ name: 'target_urgent_minutes', type: 'integer', default: 60 })
  targetUrgentMinutes!: number;

  @Column({ name: 'target_high_minutes', type: 'integer', default: 240 })
  targetHighMinutes!: number;

  @Column({ name: 'target_normal_minutes', type: 'integer', default: 1440 })
  targetNormalMinutes!: number;

  @Column({ name: 'target_low_minutes', type: 'integer', default: 4320 })
  targetLowMinutes!: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'updated_by_user_id',
    foreignKeyConstraintName: 'FK_platform_support_settings_updated_by',
  })
  updatedBy?: User | null;

  @Column({ name: 'updated_by_user_id', type: 'uuid', nullable: true })
  updatedByUserId!: string | null;
}
