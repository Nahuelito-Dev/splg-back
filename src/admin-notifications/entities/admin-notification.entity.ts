import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';

/**
 * Un aviso de la bandeja de los administradores de una distribuidora. Es de la
 * distribuidora (lo ven todos sus admins); quién lo leyó vive en
 * `admin_notification_read`, una fila por admin.
 *
 * `dedupeKey` identifica el hecho que se avisa: dentro de una distribuidora no
 * se repite, así un cron que corre cada hora no llena la bandeja.
 */
@Check(
  'CHK_admin_notification_texto',
  `btrim("kind") <> '' AND btrim("title") <> '' AND btrim("dedupe_key") <> ''`,
)
@Check(
  'CHK_admin_notification_destino',
  `("link_entity" IS NULL) = ("link_id" IS NULL)`,
)
@Unique('UQ_admin_notification_dedupe', ['distributorId', 'dedupeKey'])
// La bandeja de la plataforma (`distributor_id` nulo): el único de arriba no
// compara nulos, así que la deduplicación de esos avisos va en un único parcial.
@Index('UQ_admin_notification_dedupe_plataforma', ['dedupeKey'], {
  unique: true,
  where: '"distributor_id" IS NULL',
})
// El orden DESC no lo modela TypeORM: el índice real se crea en la migración y
// `synchronize: false` evita que `migration:generate` lo quiera cambiar.
@Index('IDX_admin_notification_distribuidora', { synchronize: false })
@Index('IDX_admin_notification_fecha', { synchronize: false })
@Entity('admin_notification')
export class AdminNotification {
  @PrimaryGeneratedColumn('uuid', { name: 'notification_id' })
  notificationId!: string;

  @ManyToOne(() => Distributor, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  /** `null`: aviso de la plataforma (bandeja del administrador general). */
  @Column({ name: 'distributor_id', type: 'uuid', nullable: true })
  distributorId!: string | null;

  @Column({ type: 'varchar', length: 60 })
  kind!: string;

  @Column({ type: 'varchar', length: 160 })
  title!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ name: 'link_entity', type: 'varchar', length: 60, nullable: true })
  linkEntity!: string | null;

  @Column({ name: 'link_id', type: 'varchar', length: 64, nullable: true })
  linkId!: string | null;

  @Column({ name: 'dedupe_key', type: 'varchar', length: 200 })
  dedupeKey!: string;

  /** Si el aviso pidió además el correo a los admins. */
  @Column({ type: 'boolean', default: false })
  email!: boolean;

  @Column({ name: 'emailed_at', type: 'timestamptz', nullable: true })
  emailedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
