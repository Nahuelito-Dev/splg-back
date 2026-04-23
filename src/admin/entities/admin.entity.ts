import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Role } from '../../role/entities/role.entity';

@Entity('admin')
export class Admin {
  @PrimaryGeneratedColumn('uuid', { name: 'admin_id' })
  admin_id: string;

  @ManyToOne(() => User, (user) => user.admins, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'uuid' })
  user_id: string;

  @ManyToOne(() => Role, (role) => role.admins, { nullable: false })
  @JoinColumn({ name: 'role_id' })
  role: Role;

  @Column({ type: 'uuid' })
  role_id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
