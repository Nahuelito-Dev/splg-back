import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToOne,
  OneToMany,
  CreateDateColumn,
  DeleteDateColumn,
  Index,
  JoinColumn,
} from 'typeorm';
import { Role } from '../../role/entities/role.entity';
import { Customer } from '../../customer/entities/customer.entity';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { Car } from '../../car/entities/car.entity';
import { Admin } from '../../admin/entities/admin.entity';
import { UserAddress } from '../../user-address/entities/user-address.entity';

// Índice funcional `lower(email)` (migración `IndiceEmailEnMinusculas`): las
// búsquedas por correo comparan `LOWER(email)`. TypeORM no modela expresiones:
// `synchronize: false` evita que `migration:generate` lo quiera borrar.
@Index('IDX_user_email_lower', { synchronize: false })
@Entity('user')
export class User {
  @PrimaryGeneratedColumn('uuid', { name: 'user_id' })
  userId!: string;

  @ManyToOne(() => Role, (role) => role.users, { nullable: true })
  @JoinColumn({ name: 'role_id' })
  role?: Role;

  @Column({
    name: 'role_id',
    type: 'uuid',
    nullable: true,
  })
  roleId?: string;

  // Una cuenta de acceso de Firebase corresponde a un solo usuario.
  @Column({
    name: 'firebase_uid',
    type: 'varchar',
    nullable: true,
    unique: true,
  })
  firebaseUid?: string;

  @Column({
    name: 'full_name',
    type: 'varchar',
    nullable: true,
  })
  fullName?: string;

  @Column({ type: 'varchar', nullable: true })
  selfie?: string;

  /** Key de la foto de perfil en el bucket (`users/{usuario}/{uuid}.{ext}`). */
  @Column({ name: 'photo_key', type: 'varchar', length: 512, nullable: true })
  photoKey!: string | null;

  /** URL firmada; la completa `EntityPhotoService.firmar`. No es una columna. */
  photoSignedUrl?: string | null;

  @Column({ type: 'varchar', unique: true, nullable: true })
  email?: string;

  @Column({
    name: 'phone_number',
    type: 'varchar',
    unique: true,
    nullable: true,
  })
  phoneNumber?: string;

  @Column({
    name: 'phone_verified',
    type: 'boolean',
    default: false,
  })
  phoneVerified!: boolean;

  @Column({
    name: 'email_verified',
    type: 'boolean',
    default: false,
  })
  emailVerified!: boolean;

  @Column({ type: 'boolean', default: false })
  blocked!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt?: Date;

  // Relations
  @OneToOne(() => Customer, (customer) => customer.user, { cascade: true })
  customer?: Customer;

  @OneToOne(() => Delivery, (delivery) => delivery.user, { cascade: true })
  delivery?: Delivery | null;

  // Sin `cascade`: la flota es de la distribuidora, no del usuario (revisión
  // de vehículo en uso). Si lo tuviera, dar de baja al chofer daría de baja
  // también sus vehículos (`UsersService.remove` hace `softRemove(user)` con
  // esta relación cargada) — y la flota tiene que seguir existiendo para la
  // distribuidora aunque el chofer se vaya. `car.user_id` queda como "chofer
  // habitual", informativo.
  @OneToMany(() => Car, (car) => car.user)
  cars?: Car[];

  @OneToMany(() => Admin, (admin) => admin.user)
  admins?: Admin[];

  @OneToMany(() => UserAddress, (userAddress) => userAddress.user, {
    cascade: true,
  })
  addresses?: UserAddress[];
}
