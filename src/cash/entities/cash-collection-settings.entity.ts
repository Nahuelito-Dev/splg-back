import {
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';
import { CashBox } from './cash-box.entity';

/**
 * A qué caja entra lo que se cobra por las ventas sin pasar por la mano del
 * chofer: los pagos aprobados de Mercado Pago (una billetera). Una fila por
 * distribuidora; sin fila o con la columna en null, no se asienta nada y el cobro queda «sin
 * asentar». La caja se valida por clase (un trigger de la base) y por
 * distribuidora (clave foránea compuesta).
 */
@ForeignKey(
  () => CashBox,
  ['mercadopago_cash_box_id', 'distributor_id'],
  ['cash_box_id', 'distributor_id'],
  {
    name: 'FK_cash_collection_settings_mercadopago_cash_box_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@ForeignKey(
  () => CashBox,
  ['transfer_cash_box_id', 'distributor_id'],
  ['cash_box_id', 'distributor_id'],
  {
    name: 'FK_cash_collection_settings_transfer_cash_box_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Entity('cash_collection_settings')
export class CashCollectionSettings {
  @PrimaryColumn({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @OneToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'distributor_id',
    foreignKeyConstraintName: 'FK_cash_collection_settings_distributor',
  })
  distributor?: Distributor;

  /** Billetera (`wallet`) a la que entran los pagos de Mercado Pago. */
  @Column({ name: 'mercadopago_cash_box_id', type: 'uuid', nullable: true })
  mercadoPagoCashBoxId!: string | null;

  /**
   * Sin uso desde que se retiró la transferencia; se conserva por borrado
   * lógico. No sale en ninguna respuesta ni se escribe desde la API.
   */
  @Column({
    name: 'transfer_cash_box_id',
    type: 'uuid',
    nullable: true,
    select: false,
  })
  transferCashBoxId!: string | null;

  /**
   * El administrador que dejó la configuración vigente: es el autor de los
   * movimientos que se asientan solos (webhook, devoluciones), que no tienen
   * un usuario en el request.
   */
  @Column({ name: 'updated_by_user_id', type: 'uuid' })
  updatedByUserId!: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'updated_by_user_id',
    foreignKeyConstraintName: 'FK_cash_collection_settings_updated_by',
  })
  updatedBy?: User;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
