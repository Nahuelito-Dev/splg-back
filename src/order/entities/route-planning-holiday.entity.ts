import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';

/**
 * Feriado de una distribuidora para la hoja de ruta (F34): ese día no se
 * reparte, así que la propuesta automática no arma un plan y la reprogramación
 * de un pedido lo saltea. La baja es lógica (`deletedAt`).
 *
 * Un solo feriado vigente por distribuidora y fecha: el índice único parcial
 * `UQ_route_planning_holiday_vigente` lo crea la migración (TypeORM no modela
 * los parciales).
 */
@Entity('route_planning_holiday')
@Index('UQ_route_planning_holiday_vigente', { synchronize: false })
@Check(
  'CHK_route_planning_holiday_descripcion',
  `char_length(btrim("description")) >= 2`,
)
export class RoutePlanningHoliday {
  @PrimaryGeneratedColumn('uuid', { name: 'holiday_id' })
  holidayId!: string;

  // CASCADE: sólo actúa en el borrado físico de una distribuidora (la purga de
  // la demo); la baja de un feriado es lógica.
  @Index()
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  /** El día (`AAAA-MM-DD`, día argentino). */
  @Column({ name: 'holiday_date', type: 'date' })
  date!: string;

  @Column({ name: 'description', type: 'varchar', length: 120 })
  description!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
