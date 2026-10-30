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
  UpdateDateColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';
import { MpReconciliationStatus } from '../domain/mp-reconciliation.enums';

/** Totales de una corrida, en pesos. */
export interface MpReconciliationSummary {
  /** Filas de movimiento que trajo el reporte y que la distribuidora ve. */
  rows: number;
  /** Lo que informa Mercado Pago de los cobros de la distribuidora. */
  mp: { gross: number; fees: number; taxes: number; net: number };
  /** Lo que tiene la caja de Mercado Pago en el rango. */
  cash: { income: number; expense: number; net: number };
  /** Diferencias por tipo. */
  differences: Record<string, number>;
  alreadyApplied: number;
  unreadableRows: number;
  /** Lo que ve sólo el super admin (movimientos de la cuenta que no son de ninguna distribuidora). */
  account?: { rows: number; credit: number; debit: number };
}

/**
 * Una corrida de conciliación: el pedido a Mercado Pago del reporte de
 * liberaciones de un rango y, cuando el archivo está, el resultado de
 * compararlo con el libro de cajas de la distribuidora.
 */
@Unique('UQ_mp_reconciliation_id_distribuidora', [
  'reconciliationId',
  'distributorId',
])
@Check(
  'CHK_mp_reconciliation_rango',
  `"to_date" >= "from_date" AND "to_date" - "from_date" <= 30`,
)
@Check(
  'CHK_mp_reconciliation_estado',
  `("status" = 'ready' AND "ready_at" IS NOT NULL) OR ("status" = 'failed' AND "failure_reason" IS NOT NULL) OR "status" = 'requested'`,
)
@Index('IDX_mp_reconciliation_distribuidora', ['distributorId', 'createdAt'])
@Index('IDX_mp_reconciliation_pendientes', ['status'], {
  where: `"status" = 'requested'`,
})
@Entity('mp_reconciliation')
export class MpReconciliation {
  @PrimaryGeneratedColumn('uuid', { name: 'reconciliation_id' })
  reconciliationId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'requested_by_user_id' })
  requestedBy?: User;

  @Column({ name: 'requested_by_user_id', type: 'uuid' })
  requestedByUserId!: string;

  /** Primer día del rango (hora argentina). */
  @Column({ name: 'from_date', type: 'date' })
  fromDate!: string;

  /** Último día del rango, inclusive (hora argentina). */
  @Column({ name: 'to_date', type: 'date' })
  toDate!: string;

  @Column({
    type: 'enum',
    enum: MpReconciliationStatus,
    default: MpReconciliationStatus.REQUESTED,
  })
  status!: MpReconciliationStatus;

  /** La pidió un super admin: la corrida incluye los movimientos de la cuenta que no son de ninguna distribuidora. */
  @Column({ name: 'include_account_level', type: 'boolean', default: false })
  includeAccountLevel!: boolean;

  @Column({
    name: 'mp_report_id',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  mpReportId!: string | null;

  @Column({ name: 'file_name', type: 'varchar', length: 255, nullable: true })
  fileName!: string | null;

  @Column({
    name: 'failure_reason',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  failureReason!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  summary!: MpReconciliationSummary | null;

  /** Clave en S3 del archivo completo de la cuenta (sólo lo baja el super admin). */
  @Column({
    name: 'account_report_key',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  accountReportKey!: string | null;

  /** El adjunto con el reporte filtrado a los cobros de la distribuidora. */
  @Column({ name: 'report_attachment_id', type: 'uuid', nullable: true })
  reportAttachmentId!: string | null;

  @Column({ name: 'last_checked_at', type: 'timestamptz', nullable: true })
  lastCheckedAt!: Date | null;

  @Column({ name: 'ready_at', type: 'timestamptz', nullable: true })
  readyAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
