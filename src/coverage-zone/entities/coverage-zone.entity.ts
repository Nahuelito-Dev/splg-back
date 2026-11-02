import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  DeleteDateColumn,
  Check,
  Unique,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';

/** Lo que TypeORM lee y escribe en la columna geometry: GeoJSON. */
export interface PoligonoGeoJson {
  type: 'Polygon';
  coordinates: number[][][];
}

export enum CoverageZoneSurchargeType {
  FIXED = 'fixed',
  PERCENTAGE = 'percentage',
}

/**
 * Zona de cobertura de una distribuidora, definida como POLÍGONO geográfico
 * (PostGIS). Cada empresa dibuja su(s) área(s) de reparto; un pedido sólo se
 * permite si la dirección cae dentro de alguna zona activa y vigente de esa
 * distribuidora (ST_Covers). Cada zona tiene un recargo, fijo (monto) o
 * porcentual (sobre el subtotal de los ítems), que se refleja en el cobro.
 *
 * Geometría: `Polygon` SRID 4326 (lat/lng WGS84). Se compara con el punto de la
 * dirección vía ST_Covers(zona.area, ST_SetSRID(ST_MakePoint(lng,lat),4326)) —
 * a diferencia de ST_Contains, un punto justo sobre el borde también cuenta
 * como cubierto.
 *
 * Cuando dos zonas se superponen (p. ej. un barrio chico dentro del área
 * general de la ciudad), gana la de mayor `priority`; a igual prioridad, la de
 * MENOR área (la más específica).
 */
@Check(
  'CHK_coverage_zone_vigencia',
  `"valid_until" IS NULL OR "valid_from" IS NULL OR "valid_until" > "valid_from"`,
)
@Index('UQ_coverage_zone_nombre_activa', { synchronize: false })
@Index('UQ_coverage_zone_prioridad_activa', { synchronize: false })
@Unique('UQ_coverage_zone_id_distribuidora', [
  'coverageZoneId',
  'distributorId',
])
@Entity('coverage_zone')
@Check(
  'CHK_coverage_zone_surcharge',
  `("surcharge_type" = 'fixed' AND "surcharge_value" >= 0) OR ` +
    `("surcharge_type" = 'percentage' AND "surcharge_value" >= 0 AND "surcharge_value" <= 100)`,
)
export class CoverageZone {
  @PrimaryGeneratedColumn('uuid', { name: 'coverage_zone_id' })
  coverageZoneId!: string;

  @Index()
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({
    name: 'distributor_id',
    type: 'uuid',
  })
  distributorId!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  /**
   * Polígono del área (PostGIS geometry). spatialFeatureType 'Polygon' + SRID
   * 4326. TypeORM lo lee/escribe como GeoJSON ({ type:'Polygon', coordinates })
   * con la columna de tipo geometry.
   */
  @Index({ spatial: true })
  @Column({
    type: 'geometry',
    spatialFeatureType: 'Polygon',
    srid: 4326,
  })
  area!: PoligonoGeoJson;

  /**
   * `fixed`: `surchargeValue` es un monto en la moneda del pedido.
   * `percentage`: `surchargeValue` es un porcentaje (0-100) sobre el subtotal
   * de los ítems. Default `percentage`: es el caso de uso que pidió el dueño
   * ("tanto % más caro en Garupá").
   */
  @Column({
    name: 'surcharge_type',
    type: 'enum',
    enum: CoverageZoneSurchargeType,
    nullable: false,
    default: CoverageZoneSurchargeType.PERCENTAGE,
  })
  surchargeType!: CoverageZoneSurchargeType;

  /** Monto (fixed) o porcentaje (percentage) del recargo, según `surchargeType`. */
  @Column({
    name: 'surcharge_value',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
    default: 0,
  })
  surchargeValue!: number;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  /** Baja lógica: la fila se conserva para el historial y la auditoría. */
  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @Column({ name: 'label', type: 'varchar', length: 40, nullable: true })
  label!: string | null;

  /** Color hexadecimal (`#RRGGBB`) para pintar la zona en el mapa del panel. */
  @Column({ name: 'color', type: 'varchar', length: 7, nullable: true })
  color!: string | null;

  /**
   * Desempate entre zonas superpuestas: gana la de mayor `priority` (y, a
   * igual prioridad, la de menor área). 0 = sin prioridad especial.
   */
  @Column({ type: 'int', default: 0 })
  priority!: number;

  /** Desde cuándo rige la zona. Un día `YYYY-MM-DD` del alta se guarda como las 00:00 ART. Null = rige desde siempre. */
  @Column({ name: 'valid_from', type: 'timestamptz', nullable: true })
  validFrom!: Date | null;

  /** Hasta cuándo rige la zona: pasado este instante vence. Un día `YYYY-MM-DD` del alta se guarda como las 23:59:59.999 ART de ese día. Null = no vence. */
  @Column({ name: 'valid_until', type: 'timestamptz', nullable: true })
  validUntil!: Date | null;
}
