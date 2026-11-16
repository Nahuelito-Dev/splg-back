import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';

/**
 * Última diferencia de conciliación que se avisó a una distribuidora: la firma
 * (hash de las diferencias) evita repetir el mismo mail todas las noches. Se
 * borra cuando la conciliación vuelve a cerrar, así un desvío nuevo vuelve a
 * avisar.
 */
@Entity('stock_reconciliation_alert')
export class StockReconciliationAlert {
  @PrimaryColumn({
    name: 'distributor_id',
    type: 'uuid',
    primaryKeyConstraintName: 'PK_stock_reconciliation_alert',
  })
  distributorId!: string;

  @ManyToOne(() => Distributor, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'distributor_id',
    foreignKeyConstraintName: 'FK_stock_reconciliation_alert_distributor',
  })
  distributor?: Distributor;

  @Column({ type: 'varchar', length: 64 })
  signature!: string;

  @Column({ name: 'alerted_at', type: 'timestamptz', default: () => 'now()' })
  alertedAt!: Date;
}
