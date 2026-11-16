import {
  Index,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { AdminNotification } from './admin-notification.entity';

/** Marca de lectura por administrador: lo que lee uno no queda leído para otro. */
@Index('IDX_admin_notification_read_usuario', ['userId'])
@Entity('admin_notification_read')
export class AdminNotificationRead {
  @ManyToOne(() => AdminNotification, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'notification_id' })
  notification?: AdminNotification;

  @PrimaryColumn({ name: 'notification_id', type: 'uuid' })
  notificationId!: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'read_at', type: 'timestamptz', default: () => 'now()' })
  readAt!: Date;
}
