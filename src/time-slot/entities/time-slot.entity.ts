import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Check,
  Exclusion,
  Unique,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';

@Check('CHK_time_slot_horario', `"startTime" < "endTime"`)
@Check('CHK_time_slot_capacidad', `"capacity" > 0`)
@Index('UQ_time_slot_nombre_activa', { synchronize: false })
@Exclusion(
  'EXC_time_slot_solapada',
  `USING gist ("distributor_id" WITH =, tsrange(timestamp '2000-01-01' + "startTime", timestamp '2000-01-01' + "endTime") WITH &&) WHERE ("isActive" AND "startTime" IS NOT NULL AND "endTime" IS NOT NULL)`,
)
@Unique('UQ_time_slot_id_distribuidora', ['timeSlotId', 'distributorId'])
@Entity('time_slot')
export class TimeSlot {
  @PrimaryGeneratedColumn('uuid', { name: 'time_slot_id' })
  timeSlotId!: string;

  /** Tenant dueño de la franja. Nullable hasta backfill del seed. */
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
  name!: string; // Ej: "Mañana", "Tarde"

  @Column({ type: 'time' })
  startTime!: string; // Ej: "09:00"

  @Column({ type: 'time' })
  endTime!: string; // Ej: "13:00"

  @Column({ type: 'int', default: 50 })
  capacity!: number; // Daily capacity

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
