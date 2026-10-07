import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('role')
// El nombre es único entre los roles vigentes: uno dado de baja libera el nombre.
@Index('UQ_role_type_vigente', ['type'], {
  unique: true,
  where: '"deletedAt" IS NULL',
})
export class Role {
  @PrimaryGeneratedColumn('uuid', { name: 'role_id' })
  roleId!: string;

  // El código busca los roles por este texto: tiene que ser único.
  @Column({ type: 'text' })
  type!: string;

  @CreateDateColumn({ type: 'timestamptz', nullable: true })
  createdAt!: Date | null;

  @UpdateDateColumn({ type: 'timestamptz', nullable: true })
  updatedAt!: Date | null;

  /** Baja lógica: el rol queda para histórico y deja de aparecer. */
  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @OneToMany(() => User, (user) => user.role)
  users!: User[];
}
