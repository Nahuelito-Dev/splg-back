import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToOne,
  OneToMany,
  CreateDateColumn,
  DeleteDateColumn,
  JoinColumn,
} from 'typeorm';
import { Role } from '../../role/entities/role.entity';
import { Customer } from '../../customer/entities/customer.entity';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { Car } from '../../car/entities/car.entity';
import { Admin } from '../../admin/entities/admin.entity';
import { UserAddress } from '../../user-address/entities/user-address.entity';

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

  @OneToMany(() => Car, (car) => car.user, { cascade: true })
  cars?: Car[];

  @OneToMany(() => Admin, (admin) => admin.user)
  admins?: Admin[];

  @OneToMany(() => UserAddress, (userAddress) => userAddress.user, {
    cascade: true,
  })
  addresses?: UserAddress[];
}
