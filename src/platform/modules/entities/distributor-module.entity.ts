import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Distributor } from '../../../distributor/entities/distributor.entity';
import { User } from '../../../users/entities/user.entity';
import { checkModuloConocido } from '../catalogo-de-modulos';

/**
 * Excepción de la plataforma sobre el plan de una distribuidora para un
 * módulo (§4.2). `enabled`: `true` lo habilita aunque el plan no lo traiga,
 * `false` lo deshabilita aunque lo traiga, `null` vuelve a lo del plan (la fila
 * no se borra: queda el motivo de la última decisión). Con `expires_at`, la
 * excepción deja de regir sola a esa hora.
 */
@Check('CHK_distributor_module_clave', checkModuloConocido('module_key'))
@Check(
  'CHK_distributor_module_motivo',
  `char_length(btrim("reason")) BETWEEN 10 AND 300`,
)
@Check(
  'CHK_distributor_module_vencimiento',
  `"enabled" IS NOT NULL OR "expires_at" IS NULL`,
)
@Entity('distributor_module')
export class DistributorModule {
  @PrimaryColumn({
    name: 'distributor_id',
    type: 'uuid',
    primaryKeyConstraintName: 'PK_distributor_module',
  })
  distributorId!: string;

  @PrimaryColumn({
    name: 'module_key',
    type: 'varchar',
    length: 40,
    primaryKeyConstraintName: 'PK_distributor_module',
  })
  moduleKey!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'distributor_id',
    foreignKeyConstraintName: 'FK_distributor_module_distributor',
  })
  distributor?: Distributor;

  @Column({ name: 'enabled', type: 'boolean', nullable: true })
  enabled!: boolean | null;

  @Column({ name: 'reason', type: 'varchar', length: 300 })
  reason!: string;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ name: 'updated_by', type: 'uuid' })
  updatedBy!: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'updated_by',
    foreignKeyConstraintName: 'FK_distributor_module_updated_by',
  })
  updatedByUser?: User;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
