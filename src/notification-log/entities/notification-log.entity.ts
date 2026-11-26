import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { Order } from '../../order/entities/order.entity';
import { User } from '../../users/entities/user.entity';
import { NotificationChannel, NotificationStatus } from '../domain/aviso';

/**
 * Registro de cada aviso que salió del sistema (push y correo). Sólo se
 * agrega: no se edita ni se borra. `distributorId` `null` es un envío de
 * plataforma. Es una tabla técnica de alto volumen: no entra en la auditoría
 * de datos (ver `TABLAS_EXCLUIDAS`).
 */
@Check('CHK_notification_log_canal', `"channel" IN ('push', 'email')`)
@Check(
  'CHK_notification_log_estado',
  `"status" IN ('sent', 'failed', 'skipped')`,
)
@Check('CHK_notification_log_error', `"status" <> 'sent' OR "error" IS NULL`)
// El orden DESC no lo modela TypeORM: el índice real se crea en la migración.
@Index('IDX_notification_log_distribuidora_fecha', { synchronize: false })
@Index('IDX_notification_log_distribuidora_estado_fecha', {
  synchronize: false,
})
@Index('IDX_notification_log_pedido', ['relatedOrderId'])
@Entity('notification_log')
export class NotificationLog {
  @PrimaryGeneratedColumn('uuid', { name: 'notification_log_id' })
  notificationLogId!: string;

  @ManyToOne(() => Distributor, {
    nullable: true,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'distributor_id',
    foreignKeyConstraintName: 'FK_notification_log_distribuidora',
  })
  distributor?: Distributor | null;

  @Column({ name: 'distributor_id', type: 'uuid', nullable: true })
  distributorId!: string | null;

  @Column({ type: 'varchar', length: 10 })
  channel!: NotificationChannel;

  @Column({ type: 'varchar', length: 60 })
  type!: string;

  @ManyToOne(() => User, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({
    name: 'recipient_user_id',
    foreignKeyConstraintName: 'FK_notification_log_destinatario',
  })
  recipientUser?: User | null;

  @Column({ name: 'recipient_user_id', type: 'uuid', nullable: true })
  recipientUserId!: string | null;

  /** Correo enmascarado (`n***@dominio`) o los últimos 6 caracteres del token. */
  @Column({ name: 'recipient_masked', type: 'varchar', length: 120 })
  recipientMasked!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  subject!: string | null;

  @Column({ type: 'varchar', length: 10 })
  status!: NotificationStatus;

  @Column({ type: 'varchar', length: 300, nullable: true })
  error!: string | null;

  @ManyToOne(() => Order, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({
    name: 'related_order_id',
    foreignKeyConstraintName: 'FK_notification_log_pedido',
  })
  relatedOrder?: Order | null;

  @Column({ name: 'related_order_id', type: 'uuid', nullable: true })
  relatedOrderId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
