import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Estado de un aviso guardado en la bandeja de entrada de notificaciones. */
export enum EstadoDelAvisoGuardado {
  PENDING = 'pending',
  PROCESSED = 'processed',
  /** Se agotaron los reintentos propios: el administrador ya fue avisado. */
  FAILED = 'failed',
}

/**
 * Bandeja de entrada (outbox) de los avisos de Mercado Pago que NO se reintentan: la
 * alerta de fraude (`stop_delivery_op_wh`) se pierde si no se contesta 200/201
 * (https://www.mercadopago.com.ar/developers/es/docs/your-integrations/notifications/additional-info).
 * Con la firma válida se guarda el aviso crudo acá, se contesta 200 y se lo procesa
 * después con reintentos propios; si se agotan, se avisa al administrador.
 */
@Check(
  'CHK_payment_notification_inbox_estado',
  `"status" IN ('pending', 'processed', 'failed')`,
)
@Check('CHK_payment_notification_inbox_intentos', `"attempts" >= 0`)
// Único por tipo, recurso y CUENTA que firmó: una alerta sembrada con el secreto de otra
// cuenta no puede tapar a la verdadera. Dos índices porque `NULL` (la cuenta del sistema)
// no se compara como igual en un único.
@Index(
  'UQ_payment_notification_inbox_aviso',
  ['type', 'dataId', 'credentialId'],
  {
    unique: true,
    where: '"credential_id" IS NOT NULL',
  },
)
@Index('UQ_payment_notification_inbox_aviso_sistema', ['type', 'dataId'], {
  unique: true,
  where: '"credential_id" IS NULL',
})
@Index('IDX_payment_notification_inbox_pendientes', ['status', 'nextAttemptAt'])
@Entity('payment_notification_inbox')
export class PaymentNotificationInbox {
  @PrimaryGeneratedColumn('uuid', { name: 'notification_id' })
  notificationId!: string;

  /** Tipo de aviso (`stop_delivery_op_wh`). */
  @Column({ type: 'varchar', length: 60 })
  type!: string;

  /** Id del recurso avisado (el pago). */
  @Column({ name: 'data_id', type: 'varchar', length: 100 })
  dataId!: string;

  /** Cuenta de Mercado Pago del aviso (`?account=`); null = la del sistema. */
  @Column({ name: 'credential_id', type: 'uuid', nullable: true })
  credentialId!: string | null;

  /** Cuerpo crudo del aviso, tal como llegó. */
  @Column({ name: 'raw_body', type: 'jsonb', nullable: true })
  rawBody!: Record<string, unknown> | null;

  @Column({
    type: 'varchar',
    length: 20,
    default: EstadoDelAvisoGuardado.PENDING,
  })
  status!: EstadoDelAvisoGuardado;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @Column({
    name: 'next_attempt_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  nextAttemptAt!: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
