import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    JoinColumn,
    Index,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';

@Entity('time_slot')
export class TimeSlot {
    @PrimaryGeneratedColumn('uuid', { name: 'time_slot_id' })
    time_slot_id: string;

    /** Tenant dueño de la franja. Nullable hasta backfill del seed. */
    @Index()
    @ManyToOne(() => Distributor, { nullable: true })
    @JoinColumn({ name: 'distributor_id' })
    distributor?: Distributor;

    @Column({ type: 'uuid', nullable: true })
    distributor_id?: string;

    @Column({ type: 'varchar', length: 50 })
    name: string; // Ej: "Mañana", "Tarde"

    @Column({ type: 'time' })
    startTime: string; // Ej: "09:00"

    @Column({ type: 'time' })
    endTime: string; // Ej: "13:00"

    @Column({ type: 'int', default: 50 })
    capacity: number; // Daily capacity

    @Column({ type: 'boolean', default: true })
    isActive: boolean;

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updatedAt: Date;
}
