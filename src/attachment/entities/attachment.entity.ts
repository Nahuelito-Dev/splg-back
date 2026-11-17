import {
  Check,
  Entity,
  ForeignKey,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  DeleteDateColumn,
  Index,
  Unique,
} from 'typeorm';
import { Distributor } from '../../distributor/entities/distributor.entity';
import { User } from '../../users/entities/user.entity';
import { Message } from '../../chat/entities/message.entity';
import { AttachmentScanStatus } from '../attachment-scan-status';

/** Qué módulo es dueño del adjunto. Cada valor lo valida el resolver de su módulo. */
export enum AttachmentOwnerType {
  EMPLOYEE = 'employee',
  FUEL_LOAD = 'fuel_load',
  TRAFFIC_FINE = 'traffic_fine',
  VEHICLE_ACCIDENT = 'vehicle_accident',
  PURCHASE_RECEIPT = 'purchase_receipt',
  STOCK_ADJUSTMENT = 'stock_adjustment',
  DRIVER_SETTLEMENT = 'driver_settlement',
  CASH_MOVEMENT = 'cash_movement',
  CUSTOMER_ACCOUNT_ENTRY = 'customer_account_entry',
  ORDER = 'order',
  INSURANCE_POLICY = 'insurance_policy',
  INSURANCE_INSTALLMENT = 'insurance_installment',
  TRAFFIC_FINE_PAYMENT = 'traffic_fine_payment',
  MP_RECONCILIATION = 'mp_reconciliation',
  /** Documentación y foto de patente de un vehículo (F13). */
  CAR_DOCUMENT = 'car_document',
  /** El archivo o la foto de un mensaje del chat (CH7): `owner_id` = `message_id`. */
  CHAT_MESSAGE = 'chat_message',
}

/** Tipos que acepta algún canal del chat (lo mismo que `TIPOS_DEL_CHAT`). */
const TIPOS_DEL_CHAT_EN_SQL = `'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv'`;

/**
 * Adjunto genérico (legajo, combustible, multas, siniestros, remitos,
 * rendiciones...). El contenido vive en S3; acá la referencia y
 * la metadata. `ownerType` + `ownerId` apuntan al dueño sin FK, a propósito:
 * la tabla es polimórfica y no puede referenciar a la vez diez tablas. La
 * existencia del dueño y su distribuidora los valida el
 * `AttachmentOwnerResolver` del módulo dueño al subir y al listar.
 */
@Unique('UQ_attachment_id_distribuidora', ['attachmentId', 'distributorId'])
@Entity('attachment')
@Index(['distributorId', 'ownerType', 'ownerId'])
@ForeignKey(
  () => Message,
  ['message_id', 'distributor_id'],
  ['message_id', 'distributor_id'],
  { name: 'FK_attachment_message_distribuidora', onDelete: 'NO ACTION' },
)
@Index('UQ_attachment_mensaje', ['messageId'], {
  unique: true,
  where: '"message_id" IS NOT NULL',
})
@Index('IDX_attachment_escaneo_pendiente', ['uploadedAt'], {
  where: `"scan_status" IN ('pending', 'failed')`,
})
@Check(
  'CHK_attachment_escaneo_intentos',
  `"scan_attempts" BETWEEN 0 AND 50 AND ("message_id" IS NOT NULL OR "scan_attempts" = 0)`,
)
@Index(
  'IDX_attachment_chat_cupo',
  ['distributorId', 'uploadedByUserId', 'uploadedAt'],
  { where: '"message_id" IS NOT NULL' },
)
@Check(
  'CHK_attachment_escaneo_estado',
  `"scan_status" IN ('not_required', 'pending', 'clean', 'infected', 'failed')`,
)
@Check(
  'CHK_attachment_chat_mensaje',
  `("owner_type"::text = 'chat_message') = ("message_id" IS NOT NULL) AND ("message_id" IS NULL OR "message_id" = "owner_id")`,
)
@Check(
  'CHK_attachment_chat_escaneo',
  `("message_id" IS NOT NULL) = ("scan_status" <> 'not_required')`,
)
@Check(
  'CHK_attachment_foto_limpia',
  `"message_id" IS NULL OR "mime_type" NOT LIKE 'image/%' OR "scan_status" = 'clean'`,
)
@Check(
  'CHK_attachment_chat_tipo',
  `"message_id" IS NULL OR "mime_type" IN (${TIPOS_DEL_CHAT_EN_SQL})`,
)
@Check(
  'CHK_attachment_chat_tamano',
  `"message_id" IS NULL OR "size_bytes" BETWEEN 1 AND 10485760`,
)
@Check(
  'CHK_attachment_medidas',
  `("width" IS NULL) = ("height" IS NULL) AND ("width" IS NULL OR ("width" > 0 AND "height" > 0 AND "mime_type" LIKE 'image/%'))`,
)
@Check(
  'CHK_attachment_escaneado',
  `"scanned_at" IS NULL OR "scan_status" IN ('clean', 'infected', 'failed')`,
)
export class Attachment {
  @PrimaryGeneratedColumn('uuid', { name: 'attachment_id' })
  attachmentId!: string;

  @ManyToOne(() => Distributor, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'distributor_id' })
  distributor!: Distributor;

  @Column({ name: 'distributor_id', type: 'uuid' })
  distributorId!: string;

  @Column({
    name: 'owner_type',
    type: 'enum',
    enum: AttachmentOwnerType,
  })
  ownerType!: AttachmentOwnerType;

  /** Sin FK (ver la nota de la clase). */
  @Column({ name: 'owner_id', type: 'uuid' })
  ownerId!: string;

  /** Texto libre para distinguir adjuntos del mismo dueño: "DNI frente", "Póliza 2026". */
  @Column({ name: 'label', type: 'varchar', length: 80, nullable: true })
  label!: string | null;

  /** Clave del objeto dentro del bucket de S3. */
  @Column({ name: 'storage_key', type: 'varchar', length: 255 })
  storageKey!: string;

  @Column({ name: 'original_name', type: 'varchar', length: 255 })
  originalName!: string;

  @Column({ name: 'mime_type', type: 'varchar', length: 100 })
  mimeType!: string;

  @Column({ name: 'size_bytes', type: 'integer' })
  sizeBytes!: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'uploaded_by_user_id' })
  uploadedBy!: User;

  @Column({ name: 'uploaded_by_user_id', type: 'uuid' })
  uploadedByUserId!: string;

  @CreateDateColumn({ name: 'uploaded_at', type: 'timestamptz' })
  uploadedAt!: Date;

  /**
   * El mensaje del chat dueño del adjunto (sólo `chat_message`, igual a
   * `owner_id`): con la empresa forma la FK compuesta a `message`, así el
   * adjunto no puede ser de un mensaje de otra empresa. Uno por mensaje.
   */
  @Column({ name: 'message_id', type: 'uuid', nullable: true })
  messageId!: string | null;

  /** Escaneo antivirus (sólo los del chat; el resto, `not_required`). */
  @Column({
    name: 'scan_status',
    type: 'varchar',
    length: 15,
    default: AttachmentScanStatus.NOT_REQUIRED,
  })
  scanStatus!: AttachmentScanStatus;

  /** Intentos de escaneo hechos (sólo los del chat); con `MAX_INTENTOS_DE_ESCANEO`, `failed` queda así. */
  @Column({ name: 'scan_attempts', type: 'smallint', default: 0 })
  scanAttempts!: number;

  /** Cuándo el escáner terminó (limpio, infectado o falló tras los reintentos). */
  @Column({ name: 'scanned_at', type: 'timestamptz', nullable: true })
  scannedAt!: Date | null;

  /** Medidas en píxeles de una foto del chat (ya re-codificada). */
  @Column({ type: 'integer', nullable: true })
  width!: number | null;

  @Column({ type: 'integer', nullable: true })
  height!: number | null;

  /**
   * Baja lógica: el registro queda para histórico y el archivo NO se borra del
   * storage (queda de respaldo). Los listados y descargas no lo muestran.
   */
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
