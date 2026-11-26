import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { columnNumericTransformer } from '../../common/transformers/column-numeric.transformer';

/**
 * Tiempo de atención aprendido (M4): cuánto se demora el chofer en cada parada,
 * medido de «Llegué» a la entrega confirmada, de los últimos 30 días. Una fila
 * por distribuidora, que el cálculo nocturno reescribe. Sin muestra suficiente
 * la mediana y el p90 quedan en `null`: la planificación usa el fijo.
 */
@Check('CHK_route_service_time_stat_muestras', `"samples" >= 0`)
@Check(
  'CHK_route_service_time_stat_minutos',
  `("median_min" IS NULL) = ("p90_min" IS NULL) AND ("median_min" IS NULL OR ("median_min" BETWEEN 1 AND 60 AND "p90_min" BETWEEN "median_min" AND 60))`,
)
@Index('UQ_route_service_time_stat_distribuidora', ['distributorId'], {
  unique: true,
})
@Entity('route_service_time_stat')
export class RouteServiceTimeStat {
  @PrimaryGeneratedColumn('uuid', { name: 'stat_id' })
  statId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  /** Entregas válidas de la ventana (antes de descartar los extremos). */
  @Column({ name: 'samples', type: 'integer', nullable: false })
  samples!: number;

  /** Mediana en minutos (1 a 60); `null` si no alcanzaron las muestras. */
  @Column({
    name: 'median_min',
    type: 'decimal',
    precision: 5,
    scale: 2,
    transformer: columnNumericTransformer,
    nullable: true,
  })
  medianMin!: number | null;

  /** Percentil 90 en minutos; `null` junto con la mediana. */
  @Column({
    name: 'p90_min',
    type: 'decimal',
    precision: 5,
    scale: 2,
    transformer: columnNumericTransformer,
    nullable: true,
  })
  p90Min!: number | null;

  /** Días de historia que se miraron. */
  @Column({ name: 'window_days', type: 'smallint', nullable: false })
  windowDays!: number;

  @Column({ name: 'computed_at', type: 'timestamptz', nullable: false })
  computedAt!: Date;
}
