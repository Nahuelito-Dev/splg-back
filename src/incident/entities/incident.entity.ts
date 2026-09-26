import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { Order } from '../../order/entities/order.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';

export enum IncidentType {
  DAMAGED = 'damaged',
  OUT_OF_STOCK = 'out_of_stock',
  NO_SHOW = 'no_show',
  OTHER = 'other',
}

export enum IncidentMoment {
  PRE_DELIVERY = 'pre_delivery',
  IN_DELIVERY = 'in_delivery',
  POST_DELIVERY = 'post_delivery',
}

export enum IncidentStatus {
  OPEN = 'open',
  RESOLVED = 'resolved',
}

/**
 * Incidencia de entrega reportada (normalmente por el chofer) sobre un
 * pedido: producto dañado, faltante de stock, cliente ausente, etc.
 * Tenant-scoped (distributor_id denormalizado del pedido) para que el panel
 * pueda filtrar/listar por distribuidora.
 */
@Entity('incident')
export class Incident {
  @PrimaryGeneratedColumn('uuid', { name: 'incident_id' })
  incident_id!: string;

  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Index()
  @Column({ type: 'uuid' })
  order_id!: string;

  @Index()
  @ManyToOne(() => Distributor, { nullable: false })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ type: 'uuid', nullable: false })
  distributor_id!: string;

  /** Usuario que reporta la incidencia (user_id), normalmente el chofer. */
  @Column({ type: 'uuid' })
  reported_by!: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'reported_by' })
  reporter?: User;

  @Column({ type: 'enum', enum: IncidentType })
  type!: IncidentType;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'varchar', nullable: true })
  photo_url!: string | null;

  @Column({
    type: 'enum',
    enum: IncidentStatus,
    default: IncidentStatus.OPEN,
  })
  status!: IncidentStatus;

  @Column({ type: 'text', nullable: true })
  resolution_note!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @Column({
    name: 'moment',
    type: 'enum',
    enum: IncidentMoment,

    nullable: true,
  })
  moment!: IncidentMoment | null;
}
