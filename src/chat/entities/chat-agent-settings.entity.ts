import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Admin } from '../../admin/entities/admin.entity';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';
import type { EstadoDelAgente } from '../domain/asignacion-automatica';

/**
 * Lo de cada persona del equipo en la bandeja de su empresa (tanda 8b): si
 * está «en línea» o «ausente» (y desde cuándo), su tope propio de
 * conversaciones abiertas (nulo: el de la empresa) y cuándo recibió la
 * última por asignación automática (para desempatar). Una fila por empresa y
 * persona; sin fila, ausente y con el tope de la empresa. La persona tiene
 * que ser del personal de esa empresa (`FK_chat_agent_settings_user_distribuidora`
 * contra el perfil de administrador).
 */
@Entity('chat_agent_settings')
@ForeignKey(
  () => Admin,
  ['user_id', 'distributor_id'],
  ['user_id', 'distributor_id'],
  {
    name: 'FK_chat_agent_settings_user_distribuidora',
    onDelete: 'NO ACTION',
  },
)
@Check('CHK_chat_agent_settings_estado', `"status" IN ('online', 'away')`)
@Check(
  'CHK_chat_agent_settings_tope',
  `"max_open_override" IS NULL OR "max_open_override" BETWEEN 1 AND 50`,
)
export class ChatAgentSettings {
  @PrimaryColumn({
    name: 'distributor_id',
    type: 'uuid',
    primaryKeyConstraintName: 'PK_chat_agent_settings',
  })
  distributorId!: string;

  @PrimaryColumn({
    name: 'user_id',
    type: 'uuid',
    primaryKeyConstraintName: 'PK_chat_agent_settings',
  })
  userId!: string;

  // RESTRICT: la baja de una empresa o de una persona es lógica; esto queda.
  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'distributor_id',
    foreignKeyConstraintName: 'FK_chat_agent_settings_distributor',
  })
  distributor?: Distributor;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_chat_agent_settings_user',
  })
  user?: User;

  @Column({ type: 'varchar', length: 10, default: 'away' })
  status!: EstadoDelAgente;

  @Column({
    name: 'status_changed_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  statusChangedAt!: Date;

  /** El tope propio de conversaciones abiertas (1 a 50); nulo: el de la empresa. */
  @Column({ name: 'max_open_override', type: 'smallint', nullable: true })
  maxOpenOverride!: number | null;

  /** La última vez que recibió una conversación por asignación automática. */
  @Column({ name: 'last_assigned_at', type: 'timestamptz', nullable: true })
  lastAssignedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
