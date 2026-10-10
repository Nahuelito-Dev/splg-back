import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  OneToMany,
  Unique,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { GasCylinderPromotion } from './gascylinder-promotion.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';

@Entity('gas_cylinder')
// El tipo es la clave natural del producto dentro de una distribuidora.
@Unique('UQ_gas_cylinder_distribuidora_tipo', ['distributorId', 'type'])
export class GasCylinder {
  @PrimaryGeneratedColumn('uuid', { name: 'gas_cylinder_id' })
  gasCylinderId!: string;

  /** Distribuidora dueña del producto. */
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

  @Column({ type: 'varchar', length: 50 })
  type!: string; // '10kg', '15kg', '45kg'

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  weight!: number;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
  })
  price!: number;

  @Column({ type: 'int', default: 0 })
  stock!: number;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  /** Key de la imagen del producto en el bucket (`gascylinders/{distribuidora}/{producto}/{uuid}.{ext}`). */
  @Column({ name: 'photo_key', type: 'varchar', length: 512, nullable: true })
  photoKey!: string | null;

  /** URL firmada; la completa `EntityPhotoService.firmar`. No es una columna. */
  photoSignedUrl?: string | null;

  /** Promociones por volumen; se guardan y se reemplazan junto con el producto. */
  @OneToMany(() => GasCylinderPromotion, (p) => p.gasCylinder, {
    cascade: true,
  })
  promotions?: GasCylinderPromotion[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
