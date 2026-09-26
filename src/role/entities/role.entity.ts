import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('role')
export class Role {
  @PrimaryGeneratedColumn('uuid', { name: 'role_id' })
  roleId!: string;

  // El código busca los roles por este texto: tiene que ser único.
  @Column({ type: 'text', unique: true })
  type!: string;

  @CreateDateColumn({ type: 'timestamptz', nullable: true })
  createdAt!: Date | null;

  @UpdateDateColumn({ type: 'timestamptz', nullable: true })
  updatedAt!: Date | null;

  @OneToMany(() => User, (user) => user.role)
  users!: User[];
}
