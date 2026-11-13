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
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';

/** Nombre del rol de sistema que nace con cada distribuidora. */
export const NOMBRE_DEL_ROL_DE_SISTEMA = 'Administrador';

/**
 * Rol del personal del panel (F37): qué permisos del catálogo
 * (`common/permisos/catalogo.ts`) tiene cada `admin` de una distribuidora.
 *
 * El rol de sistema («Administrador») tiene todos los permisos, incluidos los
 * que el catálogo sume más adelante: por eso no guarda la lista
 * (`CHK_staff_role_sistema_sin_lista`) y no se edita ni se borra. Lo crea la
 * base al dar de alta la distribuidora (`staff_role_de_sistema`, migración
 * `RolesDelPersonal`).
 *
 * Únicos entre los vigentes, con índices funcionales/parciales que crea la
 * migración (TypeORM no los modela; `synchronize: false` evita que
 * `migration:generate` quiera borrarlos): el nombre por distribuidora sin
 * distinguir mayúsculas y un solo rol de sistema por distribuidora.
 */
@Entity('staff_role')
@Unique('UQ_staff_role_id_distribuidora', ['staffRoleId', 'distributorId'])
@Index('UQ_staff_role_nombre_vigente', { synchronize: false })
@Index('UQ_staff_role_sistema_vigente', { synchronize: false })
@Check('CHK_staff_role_nombre', `char_length(btrim("name")) >= 2`)
@Check(
  'CHK_staff_role_sistema_sin_lista',
  `NOT "is_system" OR cardinality("permissions") = 0`,
)
export class StaffRole {
  @PrimaryGeneratedColumn('uuid', { name: 'staff_role_id' })
  staffRoleId!: string;

  // CASCADE como los puestos: sólo actúa en el borrado físico de una
  // distribuidora (la purga de la demo); la baja de un rol es lógica.
  @Index()
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({ name: 'name', type: 'varchar', length: 60 })
  name!: string;

  @Column({ name: 'description', type: 'varchar', length: 300, nullable: true })
  description!: string | null;

  /** Claves del catálogo (`pedidos.ver`…). Vacía en el rol de sistema. */
  @Column({ name: 'permissions', type: 'text', array: true, default: '{}' })
  permissions!: string[];

  @Column({ name: 'is_system', type: 'boolean', default: false })
  isSystem!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
