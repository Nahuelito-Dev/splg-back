import { Check, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { checkModuloConocido } from '../catalogo-de-modulos';
import { PlatformPlan } from './platform-plan.entity';

/** Un módulo que trae un plan: la presencia de la fila es «incluido». */
@Check('CHK_platform_plan_module_clave', checkModuloConocido('module_key'))
@Entity('platform_plan_module')
export class PlatformPlanModule {
  @PrimaryColumn({
    name: 'plan_code',
    type: 'varchar',
    length: 30,
    primaryKeyConstraintName: 'PK_platform_plan_module',
  })
  planCode!: string;

  @PrimaryColumn({
    name: 'module_key',
    type: 'varchar',
    length: 40,
    primaryKeyConstraintName: 'PK_platform_plan_module',
  })
  moduleKey!: string;

  @ManyToOne(() => PlatformPlan, (p) => p.modules, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'plan_code',
    foreignKeyConstraintName: 'FK_platform_plan_module_plan',
  })
  plan?: PlatformPlan;
}
