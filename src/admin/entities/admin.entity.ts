import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Role } from '../../role/entities/role.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';

@Entity('admin')
export class Admin {
  @PrimaryGeneratedColumn('uuid', { name: 'admin_id' })
  admin_id: string;

  /**
   * Distribuidora que administra. Nullable = admin de plataforma (super_admin,
   * cross-tenant); con distributor_id = admin scopeado a esa distribuidora.
   */
  @Index()
  @ManyToOne(() => Distributor, { nullable: true })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ type: 'uuid', nullable: true })
  distributor_id?: string;

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
