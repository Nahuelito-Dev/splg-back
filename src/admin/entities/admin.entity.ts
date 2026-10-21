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
import { Distributor } from '../../distributor/entities/distributor.entity';

@Entity('admin')
export class Admin {
  @PrimaryGeneratedColumn('uuid', { name: 'admin_id' })
  adminId!: string;

  /**
   * Distribuidora que administra. Nullable = admin de plataforma (super_admin,
   * cross-tenant); con distributor_id = admin scopeado a esa distribuidora.
   */
  @Index()
  @ManyToOne(() => Distributor, { nullable: true })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor | null;

  @Column({
    name: 'distributor_id',
    type: 'uuid',
    nullable: true,
  })
  distributorId!: string | null;

  @ManyToOne(() => User, (user) => user.admins, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  /**
   * Un perfil por usuario. El rol no se guarda acá: es el del usuario
   * (`user.role_id`). Repetirlo era redundante y permitía que los dos
   * dijeran cosas distintas (H-77).
   */
  @Index('UQ_admin_user', { unique: true })
  @Column({
    name: 'user_id',
    type: 'uuid',
  })
  userId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
