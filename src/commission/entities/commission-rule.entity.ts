import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  Exclusion,
} from 'typeorm';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { Employee } from '../../employee/entities/employee.entity';
import { GasCylinder } from '../../gascylinder/entities/gascylinder.entity';
import { CommissionBasis } from '../domain/commission.enums';

/**
 * Regla de comisión por entrega. Alcance: empleado (o todos los choferes) y
 * producto (o todos). Precedencia al devengar: empleado y producto > empleado >
 * producto > general. Dos reglas activas del mismo alcance no se solapan en el
 * tiempo (lo valida el servicio bajo un lock por distribuidora).
 */
@Check(
  'CHK_commission_rule_porcentaje',
  `"basis" <> 'percent_of_total' OR "value" <= 100`,
)
@Exclusion(
  'EXC_commission_rule_solapada',
  `USING gist ("distributor_id" WITH =, COALESCE("employee_id", '00000000-0000-0000-0000-000000000000'::uuid) WITH =, COALESCE("gas_cylinder_id", '00000000-0000-0000-0000-000000000000'::uuid) WITH =, daterange("valid_from", "valid_to", '[]') WITH &&) WHERE ("is_active")`,
)
@Entity('commission_rule')
@Check('CHK_commission_rule_valor', '"value" >= 0')
@Check(
  'CHK_commission_rule_vigencia',
  '"valid_to" IS NULL OR "valid_to" >= "valid_from"',
)
@Index('IDX_commission_rule_distribuidora', ['distributorId', 'isActive'])
export class CommissionRule {
  @PrimaryGeneratedColumn('uuid', { name: 'rule_id' })
  ruleId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  /** `null`: vale para todos los choferes. */
  @ManyToOne(() => Employee, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'employee_id' })
  employee?: Employee | null;

  @Column({ name: 'employee_id', type: 'uuid', nullable: true })
  employeeId!: string | null;

  /** `null`: vale para todos los productos. */
  @ManyToOne(() => GasCylinder, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'gas_cylinder_id' })
  gasCylinder?: GasCylinder | null;

  @Column({ name: 'gas_cylinder_id', type: 'uuid', nullable: true })
  gasCylinderId!: string | null;

  @Column({ type: 'enum', enum: CommissionBasis })
  basis!: CommissionBasis;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 4,
    transformer: columnNumericTransformer,
  })
  value!: number;

  @Column({ name: 'valid_from', type: 'date' })
  validFrom!: string;

  /** `null`: sin fecha de fin. */
  @Column({ name: 'valid_to', type: 'date', nullable: true })
  validTo!: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
