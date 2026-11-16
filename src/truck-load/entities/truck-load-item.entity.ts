import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { GasCylinder } from '../../gascylinder/entities/gascylinder.entity';
import { TruckLoad } from './truck-load.entity';

/**
 * Renglón de una carga, por tipo de garrafa. Lo "declarado" lo informa el
 * chofer o el administrador al volver; lo "esperado", lo "entregado" y lo
 * "recolectado" se congelan al cerrar la rendición (mientras tanto se calculan
 * en vivo desde el libro).
 */
@Entity('truck_load_item')
@Index('UQ_truck_load_item_garrafa', ['loadId', 'gasCylinderId'], {
  unique: true,
})
@Check(
  'CHK_truck_load_item_cargado',
  '"loaded_full" >= 0 AND "reloaded_full" >= 0 AND "loaded_empty" >= 0',
)
@Check(
  'CHK_truck_load_item_declarado',
  '("declared_return_full" IS NULL OR "declared_return_full" >= 0) AND ("declared_return_empty" IS NULL OR "declared_return_empty" >= 0)',
)
export class TruckLoadItem {
  @PrimaryGeneratedColumn('uuid', { name: 'item_id' })
  itemId!: string;

  @ManyToOne(() => TruckLoad, (l) => l.items, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'load_id' })
  load?: TruckLoad;

  @Column({ name: 'load_id', type: 'uuid' })
  loadId!: string;

  @Index('IDX_truck_load_item_garrafa')
  @ManyToOne(() => GasCylinder, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'gas_cylinder_id' })
  gasCylinder?: GasCylinder;

  @Column({ name: 'gas_cylinder_id', type: 'uuid' })
  gasCylinderId!: string;

  @Column({ name: 'loaded_full', type: 'int', default: 0 })
  loadedFull!: number;

  /** Llenas repuestas en ruta (suma de las reposiciones). */
  @Column({ name: 'reloaded_full', type: 'int', default: 0 })
  reloadedFull!: number;

  /** Vacías con las que sale para canjear. */
  @Column({ name: 'loaded_empty', type: 'int', default: 0 })
  loadedEmpty!: number;

  @Column({ name: 'declared_return_full', type: 'int', nullable: true })
  declaredReturnFull!: number | null;

  @Column({ name: 'declared_return_empty', type: 'int', nullable: true })
  declaredReturnEmpty!: number | null;

  @Column({ name: 'delivered_full', type: 'int', nullable: true })
  deliveredFull!: number | null;

  @Column({ name: 'collected_empty', type: 'int', nullable: true })
  collectedEmpty!: number | null;

  @Column({ name: 'expected_full', type: 'int', nullable: true })
  expectedFull!: number | null;

  @Column({ name: 'expected_empty', type: 'int', nullable: true })
  expectedEmpty!: number | null;

  @Column({ name: 'difference_full', type: 'int', nullable: true })
  differenceFull!: number | null;

  @Column({ name: 'difference_empty', type: 'int', nullable: true })
  differenceEmpty!: number | null;
}
