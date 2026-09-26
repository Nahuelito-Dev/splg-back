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
 * permite si la dirección cae dentro de alguna zona activa de esa distribuidora
 * (ST_Contains). Cada zona puede además tener un recargo (delivery más caro en
 * zonas lejanas).
 *
 * Geometría: `Polygon` SRID 4326 (lat/lng WGS84). Se compara con el punto de la
 * dirección vía ST_Contains(zona.area, ST_SetSRID(ST_MakePoint(lng,lat),4326)).
 */
@Entity('coverage_zone')
export class CoverageZone {
  @PrimaryGeneratedColumn('uuid', { name: 'coverage_zone_id' })
  coverage_zone_id!: string;

  @Index()
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ type: 'uuid' })
  distributor_id!: string;

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

  /** Recargo por reparto en esta zona (monto fijo en la moneda del pedido). */
  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: columnNumericTransformer,
    default: 0,
  })
  surcharge!: number;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  /** Baja lógica: la fila se conserva para el historial y la auditoría. */
  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @Column({
    name: 'surcharge_type',
    type: 'enum',
    enum: CoverageZoneSurchargeType,

    nullable: false,
    default: CoverageZoneSurchargeType.FIXED,
  })
  surcharge_type!: CoverageZoneSurchargeType;

  @Column({ name: 'label', type: 'varchar', length: 40, nullable: true })
  label!: string | null;

  @Column({ name: 'color', type: 'varchar', length: 7, nullable: true })
  color!: string | null;

  @Column({ name: 'valid_until', type: 'timestamptz', nullable: true })
  valid_until!: Date | null;
}
