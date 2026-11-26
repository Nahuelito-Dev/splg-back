import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { Point } from 'typeorm';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { Order } from '../../order/entities/order.entity';
import { TimeSlot } from '../../time-slot/entities/time-slot.entity';
import {
  DeliveryKind,
  FailedVisitOutcome,
  FailedVisitReason,
  RevisitResolution,
} from '../domain/nueva-visita';

/**
 * Una visita en la que no se pudo entregar el pedido (C5): quién la informó,
 * por qué, dónde estaba el chofer (igual que la confirmación de la entrega) y
 * qué nueva visita quedó propuesta o acordada. Es el historial de visitas del
 * pedido: no se edita, salvo para anotar cómo se resolvió la propuesta.
 */
@Check(
  'CHK_order_failed_visit_motivo',
  `"reason" IN ('customer_absent', 'address_closed', 'rejected', 'other')`,
)
@Check(
  'CHK_order_failed_visit_nota',
  `"note" IS NULL OR char_length("note") <= 300`,
)
@Check(
  'CHK_order_failed_visit_otro_con_nota',
  `"reason" <> 'other' OR char_length(btrim(coalesce("note", ''))) >= 3`,
)
@Check(
  'CHK_order_failed_visit_tipo',
  `"delivery_kind" IN ('single', 'express', 'route_sheet')`,
)
@Check(
  'CHK_order_failed_visit_resultado',
  `"outcome" IN ('requeued', 'proposed', 'agreed', 'awaiting_admin')`,
)
@Check(
  'CHK_order_failed_visit_resolucion',
  `"resolution" IS NULL OR "resolution" IN ('customer_accepted', 'customer_changed', 'admin_set')`,
)
@Check(
  'CHK_order_failed_visit_resuelta',
  `("resolution" IS NULL) = ("resolved_at" IS NULL)`,
)
@Check('CHK_order_failed_visit_numero', `"visit_number" >= 1`)
@Check(
  'CHK_order_failed_visit_precision',
  `"accuracy_m" IS NULL OR ("accuracy_m" >= 0 AND "accuracy_m" <= 10000)`,
)
@Check(
  'CHK_order_failed_visit_distancia',
  `"distance_m" IS NULL OR "distance_m" >= 0`,
)
@Check(
  'CHK_order_failed_visit_fuera_de_radio',
  `NOT "out_of_range" OR "point" IS NOT NULL`,
)
@Check(
  'CHK_order_failed_visit_rol',
  `"reported_by_role" IN ('delivery', 'admin', 'super_admin')`,
)
@Check(
  'CHK_order_failed_visit_acuerdo',
  `NOT "agreed_with_customer" OR "proposed_date" IS NOT NULL`,
)
@ForeignKey(
  () => Order,
  ['order_id', 'distributor_id'],
  ['order_id', 'distributor_id'],
  { name: 'FK_order_failed_visit_order_distribuidora', onDelete: 'NO ACTION' },
)
@ForeignKey(
  () => Delivery,
  ['delivery_id', 'distributor_id'],
  ['delivery_id', 'distributor_id'],
  {
    name: 'FK_order_failed_visit_delivery_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(
  () => TimeSlot,
  ['proposed_time_slot_id', 'distributor_id'],
  ['time_slot_id', 'distributor_id'],
  {
    name: 'FK_order_failed_visit_proposed_time_slot_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(
  () => TimeSlot,
  ['final_time_slot_id', 'distributor_id'],
  ['time_slot_id', 'distributor_id'],
  {
    name: 'FK_order_failed_visit_final_time_slot_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Index('IDX_order_failed_visit_pedido', ['orderId', 'failedAt'])
@Index('IDX_order_failed_visit_distribuidora', ['distributorId', 'failedAt'])
@Entity('order_failed_visit')
export class OrderFailedVisit {
  @PrimaryGeneratedColumn('uuid', { name: 'failed_visit_id' })
  failedVisitId!: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId!: string;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  /** Número de visita fallida del pedido (1, 2…); el reintento en la misma hoja repite el de su visita. */
  @Column({ name: 'visit_number', type: 'int' })
  visitNumber!: number;

  @Column({ name: 'delivery_kind', type: 'varchar', length: 20 })
  deliveryKind!: DeliveryKind;

  @Column({ name: 'reason', type: 'varchar', length: 30 })
  reason!: FailedVisitReason;

  @Column({ name: 'note', type: 'text', nullable: true })
  note!: string | null;

  /** Dónde estaba el chofer al informar; `null` si lo cargó un admin. */
  @Column({
    name: 'point',
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  point!: Point | null;

  @Column({
    name: 'accuracy_m',
    type: 'numeric',
    precision: 8,
    scale: 2,
    nullable: true,
    transformer: {
      to: (v: number | null | undefined) => v ?? null,
      from: (v: string | null) => (v === null ? null : Number(v)),
    },
  })
  accuracyM!: number | null;

  /** Metros del punto informado al domicilio de entrega. */
  @Column({ name: 'distance_m', type: 'int', nullable: true })
  distanceM!: number | null;

  /** Informó más lejos del domicilio que el radio de llegada: no se rechaza, se marca. */
  @Column({ name: 'out_of_range', type: 'boolean', default: false })
  outOfRange!: boolean;

  @ForeignKey('user', {
    name: 'FK_order_failed_visit_informada_por',
    onDelete: 'RESTRICT',
  })
  @Column({ name: 'reported_by_user_id', type: 'uuid' })
  reportedByUserId!: string;

  @Column({ name: 'reported_by_role', type: 'varchar', length: 20 })
  reportedByRole!: string;

  /** El chofer que tenía el pedido (perfil de repartidor). */
  @Column({ name: 'delivery_id', type: 'uuid', nullable: true })
  deliveryId!: string | null;

  @Column({ name: 'failed_at', type: 'timestamptz', default: () => 'now()' })
  failedAt!: Date;

  @Column({ name: 'outcome', type: 'varchar', length: 20 })
  outcome!: FailedVisitOutcome;

  /** El chofer marcó «Acordé con el cliente» y eligió el día y la franja. */
  @Column({ name: 'agreed_with_customer', type: 'boolean', default: false })
  agreedWithCustomer!: boolean;

  /** Día propuesto (o acordado) para la nueva visita. */
  @Column({ name: 'proposed_date', type: 'date', nullable: true })
  proposedDate!: string | null;

  @Column({ name: 'proposed_time_slot_id', type: 'uuid', nullable: true })
  proposedTimeSlotId!: string | null;

  /** Cómo se resolvió la propuesta (el cliente la aceptó o la cambió, o la fijó el admin). */
  @Column({ name: 'resolution', type: 'varchar', length: 20, nullable: true })
  resolution!: RevisitResolution | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @ForeignKey('user', {
    name: 'FK_order_failed_visit_resuelta_por',
    onDelete: 'RESTRICT',
  })
  @Column({ name: 'resolved_by_user_id', type: 'uuid', nullable: true })
  resolvedByUserId!: string | null;

  /** El día y la franja que quedaron después de resolver. */
  @Column({ name: 'final_date', type: 'date', nullable: true })
  finalDate!: string | null;

  @Column({ name: 'final_time_slot_id', type: 'uuid', nullable: true })
  finalTimeSlotId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
