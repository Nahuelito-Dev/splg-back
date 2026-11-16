import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Check,
} from 'typeorm';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { CustomerAccountEntry } from '../../customer-account/entities/customer-account-entry.entity';
import { DriverSettlement } from './driver-settlement.entity';

/**
 * Cobro de cuenta corriente que el chofer hizo en la calle. No genera
 * movimiento de caja: suma al efectivo esperado de su rendición abierta y entra
 * a la caja al aprobarla (una sola puerta para el dinero de la calle).
 */
@Check('CHK_driver_settlement_collection_importe', `"amount" > 0`)
@Entity('driver_settlement_collection')
@Index('UQ_driver_settlement_collection_asiento', ['entryId'], { unique: true })
export class DriverSettlementCollection {
  @PrimaryGeneratedColumn('uuid', { name: 'collection_id' })
  collectionId!: string;

  @Index('IDX_driver_settlement_collection_rendicion')
  @ManyToOne(() => DriverSettlement, (s) => s.collections, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'settlement_id' })
  settlement?: DriverSettlement;

  @Column({ name: 'settlement_id', type: 'uuid' })
  settlementId!: string;

  @ManyToOne(() => CustomerAccountEntry, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'entry_id' })
  entry?: CustomerAccountEntry;

  @Column({ name: 'entry_id', type: 'uuid' })
  entryId!: string;

  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  amount!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
