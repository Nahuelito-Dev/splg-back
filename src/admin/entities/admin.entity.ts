import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
  Check,
  ForeignKey,
  Unique,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { StaffRole } from './staff-role.entity';

/**
 * Rol de personal (F37): todo admin de una distribuidora tiene uno, y de su
 * misma distribuidora (`FK_admin_staff_role_distribuidora`); el super admin,
 * que no es de ninguna, no tiene. Si el alta no lo indica, la base le pone el
 * rol de sistema de la distribuidora (`TRG_admin_rol_de_personal`).
 */
@Check(
  'CHK_admin_rol_de_personal',
  `("distributor_id" IS NULL) = ("staff_role_id" IS NULL)`,
)
@ForeignKey(
  () => StaffRole,
  ['staff_role_id', 'distributor_id'],
  ['staff_role_id', 'distributor_id'],
  { name: 'FK_admin_staff_role_distribuidora', onDelete: 'NO ACTION' },
)
// Para las claves compuestas que exigen que una persona sea del personal de
// esa empresa (la bandeja del chat, 8b). `user_id` ya es único: esto no
// restringe nada más.
@Unique('UQ_admin_id_distribuidora', ['userId', 'distributorId'])
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

  @ManyToOne(() => StaffRole, { nullable: true })
  @JoinColumn({ name: 'staff_role_id' })
  staffRole?: StaffRole | null;

  @Index()
  @Column({ name: 'staff_role_id', type: 'uuid', nullable: true })
  staffRoleId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
