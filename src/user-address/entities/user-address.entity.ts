// user-address/entities/user-address.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
  Point,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/** Con qué precisión quedó resuelta la dirección contra el mapa. */
export enum PrecisionDeGeocodificacion {
  EXACT = 'exact',
  APPROXIMATE = 'approximate',
  UNRESOLVED = 'unresolved',
}

@Index('UQ_user_address_principal', { synchronize: false })
@Entity('user_address')
export class UserAddress {
  @PrimaryGeneratedColumn('uuid', { name: 'address_id' })
  addressId!: string;

  @ManyToOne(() => User, (user) => user.addresses, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({
    name: 'user_id',
    type: 'uuid',
  })
  userId!: string;

  @Column({ type: 'varchar', length: 255 })
  street!: string;

  @Column({ type: 'varchar', length: 100 })
  city!: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  postalCode!: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  floor!: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  apartment!: string | null;

  /**
   * Punto de la dirección (antes latitude y longitude como varchar). La API
   * sigue recibiendo y devolviendo latitude y longitude por separado.
   */
  @Index({ spatial: true })
  @Column({
    type: 'geometry',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  location!: Point | null;

  /** Identificador estable del lugar en el servicio de mapas (CU-116). */
  @Column({ name: 'place_id', type: 'varchar', length: 255, nullable: true })
  placeId!: string | null;

  /** Con qué precisión resolvió el servicio de mapas la dirección (CU-118). */
  @Column({
    name: 'geocode_precision',
    type: 'enum',
    enum: PrecisionDeGeocodificacion,
    enumName: 'address_geocode_precision_enum',
    default: PrecisionDeGeocodificacion.UNRESOLVED,
  })
  geocodePrecision!: PrecisionDeGeocodificacion;

  @Column({ type: 'text', nullable: true })
  formattedAddress!: string | null;

  @Column({ type: 'boolean', default: false })
  isDefault!: boolean;

  @Column({ type: 'text', nullable: true })
  additionalInstructions!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  /** Baja lógica: la fila se conserva para el historial y la auditoría. */
  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
