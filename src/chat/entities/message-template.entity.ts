import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { Channel, MessageTemplateScope } from '../domain/chat.enums';

/**
 * Respuestas guardadas (diseño §6.8). Las de la plataforma (`distributor_id`
 * nulo): respuestas rápidas del soporte y la automática del chat fuera de
 * horario. Las de cada empresa (CH3, `staff_reply`): respuestas rápidas de su
 * bandeja, para un canal (`channel`) o para los dos (nulo), con variables de
 * una lista cerrada (`{{cliente.nombre}}`…).
 *
 * La clave es única entre las vigentes (único parcial de `sql/mensajeria.ts`).
 */
@Entity('message_template')
@Index('UQ_message_template_clave_vigente', { synchronize: false })
@Check(
  'CHK_message_template_alcance',
  `("scope" IN ('platform_reply', 'auto_reply') AND "distributor_id" IS NULL AND "channel" IS NULL) OR ("scope" = 'staff_reply' AND "distributor_id" IS NOT NULL)`,
)
@Check(
  'CHK_message_template_canal',
  `"channel" IS NULL OR "channel" IN ('staff_customer', 'staff_driver')`,
)
@Check('CHK_message_template_clave', `"key" ~ '^[a-z0-9]+(_[a-z0-9]+)*$'`)
@Check(
  'CHK_message_template_titulo',
  `char_length(btrim("title")) BETWEEN 2 AND 60`,
)
@Check(
  'CHK_message_template_texto',
  `char_length(btrim("body")) BETWEEN 1 AND 1000`,
)
export class MessageTemplate {
  @PrimaryGeneratedColumn('uuid', {
    name: 'template_id',
    primaryKeyConstraintName: 'PK_message_template',
  })
  templateId!: string;

  @ManyToOne(() => Distributor, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'distributor_id',
    foreignKeyConstraintName: 'FK_message_template_distributor',
  })
  distributor?: Distributor | null;

  /** Nulo: de la plataforma. */
  @Column({ name: 'distributor_id', type: 'uuid', nullable: true })
  distributorId!: string | null;

  @Column({ type: 'varchar', length: 20 })
  scope!: MessageTemplateScope;

  /** El canal de la bandeja en que se ofrece; nulo: en los dos (o de la plataforma). */
  @Column({ type: 'varchar', length: 20, nullable: true })
  channel!: Channel | null;

  @Column({ type: 'varchar', length: 60 })
  key!: string;

  @Column({ type: 'varchar', length: 60 })
  title!: string;

  @Column({ type: 'varchar', length: 1000 })
  body!: string;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
