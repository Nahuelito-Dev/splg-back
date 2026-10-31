import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Distributor } from './distributor.entity';

/**
 * Cuenta de Mercado Pago propia de una distribuidora. Los tres secretos se
 * guardan cifrados (AES-256-GCM, ver `CredentialsEncryptionService`) y la
 * auditoría no los registra (`audit-exclusions.ts`). Una sola fila activa por
 * distribuidora: desactivarla (`active = false`) devuelve el cobro a la cuenta del
 * sistema, y reemplazarla deja la anterior desactivada, que sigue sirviendo para
 * los pagos que ya se cobraron con ella (`Payment.credentialId`).
 * Casos: configuración de cobros de la distribuidora (API v2).
 */
@Check(
  'CHK_distributor_mp_credentials_cifradas',
  `"access_token_encrypted" <> '' AND "public_key_encrypted" <> '' AND "webhook_secret_encrypted" <> ''`,
)
@Entity('distributor_mercadopago_credentials')
@Index('UQ_distributor_mp_credentials_activa', ['distributorId'], {
  unique: true,
  where: '"active" = true',
})
export class MercadoPagoCredentials {
  @PrimaryGeneratedColumn('uuid', { name: 'credential_id' })
  credentialId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'distributor_id' })
  distributor!: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({ name: 'access_token_encrypted', type: 'text' })
  accessTokenEncrypted!: string;

  @Column({ name: 'public_key_encrypted', type: 'text' })
  publicKeyEncrypted!: string;

  @Column({ name: 'webhook_secret_encrypted', type: 'text' })
  webhookSecretEncrypted!: string;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'loaded_by_user_id' })
  loadedByUser!: User;

  @Column({ name: 'loaded_by_user_id', type: 'uuid' })
  loadedByUserId!: string;

  /** Cuándo Mercado Pago aceptó por última vez el access token. */
  @Column({ name: 'verified_at', type: 'timestamptz' })
  verifiedAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
