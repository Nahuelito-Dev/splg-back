import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  DeleteDateColumn,
  Index,
  Point,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';

@Entity('delivery')
export class Delivery {
  @PrimaryGeneratedColumn('uuid', { name: 'delivery_id' })
  deliveryId!: string;

  /** Distribuidora para la que trabaja el chofer. Nullable hasta backfill. */
  @Index()
  @ManyToOne(() => Distributor, { nullable: false })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({
    name: 'distributor_id',
    type: 'uuid',
    nullable: false,
  })
  distributorId!: string;

  @OneToOne(() => User, (user) => user.delivery, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  // Indexado: el radar/dispatch y varios findOne buscan al chofer por user_id.
  @Index()
  @Column({
    name: 'user_id',
    type: 'uuid',
  })
  userId!: string;

  @Column({ type: 'double precision', nullable: true })
  calification?: number;

  /** Última ubicación conocida (antes texto "lat,lng" en latLng). */
  @Index({ spatial: true })
  @Column({
    type: 'geometry',
    spatialFeatureType: 'Point',
    srid: 4326,
    nullable: true,
  })
  location!: Point | null;

  @Column({
    name: 'actual_location',
    type: 'text',
    nullable: true,
  })
  actualLocation?: string;

  @Column({ type: 'real', nullable: true })
  cancelledCharge?: number;

  @Column({ type: 'boolean', default: false })
  validated!: boolean;

  /**
   * Habilitación ADMINISTRATIVA: la pone/saca un admin con
   * `PATCH /delivery/:id/status`. Un chofer deshabilitado no puede ponerse en
   * línea aunque lo intente desde su app.
   *
   * Reemplaza a la vieja columna `isActive`, que mezclaba esto con la
   * presencia del chofer (ver `isAvailable`): un chofer deshabilitado podía
   * "conectarse" desde su app y volver a recibir pedidos. La columna
   * `isActive` sigue existiendo en la base (no se borra ni se renombra: la
   * sigue usando el proceso viejo mientras conviven ambos) pero este código
   * ya no la lee ni la escribe.
   */
  @Column({ type: 'boolean', default: true })
  isEnabled!: boolean;

  /**
   * Presencia: true mientras el chofer está "en línea" en su app
   * (`PATCH /delivery/user/:userId/availability`). Sale de línea al
   * desconectarse, al deshabilitarlo un admin, o al cerrar la app (el gateway
   * de sockets lo saca del radar al desconectar).
   */
  @Column({ type: 'boolean', default: false })
  isAvailable!: boolean;

  /**
   * @deprecated Mezclaba habilitación y presencia (ver `isEnabled` e
   * `isAvailable`). La columna sigue en la base porque el proceso viejo
   * (`:3100`, sin este cambio) todavía la lee y la escribe mientras conviven
   * las dos versiones; se mapea acá SOLO para que `migration:generate` no la
   * vea como una columna huérfana y proponga borrarla. Este código no la lee
   * ni la escribe: usar `isEnabled`/`isAvailable`.
   */
  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  /** Token FCM del dispositivo del chofer, para push de ofertas/estado. */
  @Column({
    name: 'notification_token',
    type: 'text',
    nullable: true,
  })
  notificationToken?: string;

  @Column({ type: 'double precision', default: 0 })
  balance!: number;

  @CreateDateColumn({ type: 'timestamptz', nullable: true })
  createdAt?: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt?: Date;
}
