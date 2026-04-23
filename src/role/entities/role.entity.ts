import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    OneToMany,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Admin } from '../../admin/entities/admin.entity';

@Entity('role')
export class Role {
    @PrimaryGeneratedColumn('uuid', { name: 'role_id' })
    role_id: string;

    @Column({ type: 'text' })
    type: string;

    @CreateDateColumn({ type: 'timestamptz', nullable: true })
    createdAt?: Date;

    @UpdateDateColumn({ type: 'timestamptz', nullable: true })
    updatedAt?: Date;

    @OneToMany(() => User, (user) => user.role)
    users: User[];

    @OneToMany(() => Admin, (admin) => admin.role)
    admins: Admin[];
}
