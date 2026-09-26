import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Distributor } from './distributor.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Los parámetros de un proceso automático. Su forma la define y la valida el
 * DTO de cada proceso (M1 no se parece a M3): la tabla sólo los guarda.
 */
export type ModuleConfigParams = Record<string, unknown>;

export enum ConfigurableProcess {
  FLEET_PLANNER = 'fleet_planner',
  REPURCHASE = 'repurchase',
  ROUTE_BATCHING = 'route_batching',
  CYLINDER_RECOVERY = 'cylinder_recovery',
  EXPRESS_DISPATCH = 'express_dispatch',
}

/**
 * Configuración de módulo
 * Los parámetros de un proceso automático para una distribuidora.
 * Casos: CU-105 a CU-108 y CU-149 (parametrización)
 */
@Entity('module_config')
@Unique('UQ_module_config_distributor_module', ['distributorId', 'module'])
export class ModuleConfig {
  @PrimaryGeneratedColumn('uuid', { name: 'config_id' })
  configId!: string;

  @Index()
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor!: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({
    name: 'module',
    type: 'enum',
    enum: ConfigurableProcess,
    enumName: 'configurable_process_enum',
    nullable: false,
  })
  module!: ConfigurableProcess;

  @Column({ name: 'params', type: 'jsonb', nullable: false })
  params!: ModuleConfigParams;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'updated_by_user_id' })
  updatedByUser?: User;

  @Column({ name: 'updated_by_user_id', type: 'uuid', nullable: true })
  updatedByUserId!: string | null;
}
