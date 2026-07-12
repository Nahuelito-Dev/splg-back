import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';

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
  coverage_zone_id: string;

  @Index()
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ type: 'uuid' })
  distributor_id: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

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
  area: object;

  /** Recargo por reparto en esta zona (monto fijo en la moneda del pedido). */
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  surcharge: number;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
