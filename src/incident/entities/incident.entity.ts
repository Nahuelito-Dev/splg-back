import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
  Check,
  ForeignKey,
} from 'typeorm';
import { Order } from '../../order/entities/order.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';

export enum IncidentType {
  DAMAGED = 'damaged',
  OUT_OF_STOCK = 'out_of_stock',
  NO_SHOW = 'no_show',
  /** El cliente recibió el pedido en efectivo y no pagó. */
  UNPAID_COLLECTION = 'unpaid_collection',
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
  /** Descartada con motivo (reporte inválido o duplicado). Es la baja lógica. */
  DISCARDED = 'discarded',
}

/**
 * Incidencia de entrega reportada (normalmente por el chofer) sobre un
 * pedido: producto dañado, faltante de stock, cliente ausente, etc.
 * Tenant-scoped (distributor_id denormalizado del pedido) para que el panel
 * pueda filtrar/listar por distribuidora.
 */
@Index('UQ_incident_cobro_impago', ['orderId'], {
  unique: true,
  where: `"type" = 'unpaid_collection' AND "status" IN ('open', 'resolved')`,
})
@Check('CHK_incident_descripcion', `btrim("description") <> ''`)
@ForeignKey(
  () => Order,
  ['order_id', 'distributor_id'],
  ['order_id', 'distributor_id'],
  { name: 'FK_incident_order_distribuidora', onDelete: 'NO ACTION' },
)
@Check(
  'CHK_incident_largo_de_textos',
  `char_length("description") <= 1000 AND ("resolution_note" IS NULL OR char_length("resolution_note") <= 1000)`,
)
@Entity('incident')
export class Incident {
  @PrimaryGeneratedColumn('uuid', { name: 'incident_id' })
  incidentId!: string;

  @ManyToOne(() => Order, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Index()
  @Column({
    name: 'order_id',
    type: 'uuid',
  })
  orderId!: string;

  @Index()
  @ManyToOne(() => Distributor, { nullable: false })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({
    name: 'distributor_id',
    type: 'uuid',
    nullable: false,
  })
  distributorId!: string;

  /** Usuario que reporta la incidencia (user_id), normalmente el chofer. */
  @Column({
    name: 'reported_by',
    type: 'uuid',
  })
  reportedBy!: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'reported_by' })
  reporter?: User;

  @Column({ type: 'enum', enum: IncidentType })
  type!: IncidentType;

  @Column({ type: 'text' })
  description!: string;

  @Column({
    name: 'photo_url',
    type: 'varchar',
    nullable: true,
  })
  photoUrl!: string | null;

  /** Key de la foto de la incidencia en el bucket (`incidents/{distribuidora}/{incidencia}/{uuid}.{ext}`). */
  @Column({ name: 'photo_key', type: 'varchar', length: 512, nullable: true })
  photoKey!: string | null;

  /** URL firmada; la completa `EntityPhotoService.firmar`. No es una columna. */
  photoSignedUrl?: string | null;

  @Column({
    type: 'enum',
    enum: IncidentStatus,
    default: IncidentStatus.OPEN,
  })
  status!: IncidentStatus;

  @Column({
    name: 'resolution_note',
    type: 'text',
    nullable: true,
  })
  resolutionNote!: string | null;

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
