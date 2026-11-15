import {
  Check,
  Column,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Distributor } from './distributor.entity';
import { User } from '../../users/entities/user.entity';
import type {
  MedicionDeContraste,
  TokensDelTema,
} from '../theme/generador-de-tema';

/**
 * Tema por distribuidora (diseño de la plataforma, §4.8): color principal,
 * acento opcional y nombre para mostrar, con los tokens derivados y el
 * contraste medido al guardar. Sin fila (o dada de baja con «Restablecer») la
 * empresa usa el tema por omisión con su nombre real. El logo sigue siendo
 * `distributor.logo_key`.
 *
 * `version` sube en cada cambio (también al restablecer) y nunca baja: el panel
 * y las apps la usan para saber si lo que tienen guardado sigue vigente.
 */
@Check('CHK_distributor_theme_primario', `"primary_color" ~ '^#[0-9A-F]{6}$'`)
@Check(
  'CHK_distributor_theme_acento',
  `"accent_color" IS NULL OR "accent_color" ~ '^#[0-9A-F]{6}$'`,
)
@Check(
  'CHK_distributor_theme_nombre',
  `"display_name" IS NULL OR char_length(btrim("display_name")) BETWEEN 2 AND 60`,
)
@Check('CHK_distributor_theme_version', `"version" >= 1`)
@Entity('distributor_theme')
export class DistributorTheme {
  @PrimaryColumn('uuid', { name: 'distributor_id' })
  distributorId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'distributor_id' })
  distributor?: Distributor;

  @Column({ name: 'primary_color', type: 'char', length: 7 })
  primaryColor!: string;

  @Column({ name: 'accent_color', type: 'char', length: 7, nullable: true })
  accentColor!: string | null;

  @Column({
    name: 'display_name',
    type: 'varchar',
    length: 60,
    nullable: true,
  })
  displayName!: string | null;

  @Column({ name: 'tokens', type: 'jsonb' })
  tokens!: TokensDelTema;

  @Column({ name: 'contrast', type: 'jsonb' })
  contrast!: MedicionDeContraste[];

  @Column({ name: 'version', type: 'integer', default: 1 })
  version!: number;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'updated_by' })
  updatedByUser?: User;

  @Column({ name: 'updated_by', type: 'uuid', nullable: true })
  updatedBy!: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  /** «Restablecer»: baja lógica; la empresa vuelve al tema por omisión. */
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
