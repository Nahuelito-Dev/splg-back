import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsObject,
  IsString,
  IsUUID,
  MaxLength,
  Max,
  Min,
} from 'class-validator';

import { TipoDeDocumento } from '../../document-reader/tipos-de-documento';
import type { DocumentProposalAction } from '../entities/document-reading.entity';
import { DocumentReadingStatus } from '../entities/document-reading.entity';

const ACCIONES_DE_PROPUESTA: DocumentProposalAction[] = [
  'pay_installment',
  'pay_fine',
  'update_policy',
  'register_purchase_invoice',
  'update_employee_document',
  'review',
];

export class DocumentProposalDifferenceDto {
  @ApiProperty({ example: 'importe' })
  field!: string;

  @ApiProperty({ type: String, nullable: true, example: '150000.00' })
  expected!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '145000' })
  read!: string | null;

  @ApiProperty({ example: 'El importe del comprobante difiere del esperado' })
  message!: string;
}

export class DocumentProposalDto {
  @ApiProperty({ enum: ACCIONES_DE_PROPUESTA })
  action!: DocumentProposalAction;

  @ApiProperty({ example: 'insurance_installment' })
  ownerType!: string;

  @ApiProperty({ format: 'uuid' })
  ownerId!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string', nullable: true },
    description: 'Lo que el sistema esperaba, por campo',
  })
  expected!: Record<string, string | null>;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string', nullable: true },
    description: 'Lo que se leyó del documento, por campo',
  })
  read!: Record<string, string | null>;

  @ApiProperty({ type: [DocumentProposalDifferenceDto] })
  differences!: DocumentProposalDifferenceDto[];

  @ApiProperty({ example: 'Comprobante de cuota listo para confirmar.' })
  summary!: string;
}

export class QueryDocumentReadingsDto {
  @ApiPropertyOptional({ enum: DocumentReadingStatus })
  @IsOptional()
  @IsEnum(DocumentReadingStatus)
  status?: DocumentReadingStatus;

  @ApiPropertyOptional({ enum: TipoDeDocumento, description: 'Tipo detectado' })
  @IsOptional()
  @IsEnum(TipoDeDocumento)
  type?: TipoDeDocumento;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

export class CampoLeidoDto {
  @ApiProperty({ example: 'importe' })
  nombre!: string;

  @ApiProperty({ type: String, nullable: true, example: '38390.00' })
  valor!: string | null;

  @ApiProperty({ enum: ['alta', 'media', 'baja'] })
  confianza!: 'alta' | 'media' | 'baja';
}

export class DocumentReadingAttachmentDto {
  @ApiProperty({ format: 'uuid' })
  attachmentId!: string;

  @ApiProperty()
  originalName!: string;

  @ApiProperty({ example: 'application/pdf' })
  mimeType!: string;

  @ApiProperty({
    description: 'Dueño del adjunto (cuota de seguro, multa, legajo...)',
  })
  ownerType!: string;

  @ApiProperty({ format: 'uuid' })
  ownerId!: string;
}

export class DocumentReadingDto {
  @ApiProperty({ format: 'uuid' })
  readingId!: string;

  @ApiProperty({ format: 'uuid' })
  attachmentId!: string;

  @ApiProperty({ enum: DocumentReadingStatus })
  status!: DocumentReadingStatus;

  @ApiProperty({ enum: TipoDeDocumento, nullable: true })
  expectedType!: TipoDeDocumento | null;

  @ApiProperty({ enum: TipoDeDocumento, nullable: true })
  detectedType!: TipoDeDocumento | null;

  @ApiProperty({ type: Boolean, nullable: true })
  legible!: boolean | null;

  @ApiProperty({ type: CampoLeidoDto, isArray: true })
  fields!: CampoLeidoDto[];

  @ApiProperty({ type: String, isArray: true })
  warnings!: string[];

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  duplicateOfId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'claude-opus-5-5' })
  model!: string | null;

  @ApiProperty({ description: 'Costo estimado en dólares', example: 0.0237 })
  costUsd!: number;

  @ApiProperty()
  attempts!: number;

  @ApiProperty({ type: String, nullable: true })
  lastError!: string | null;

  @ApiProperty({
    type: DocumentProposalDto,
    nullable: true,
    description: 'Propuesta de conciliación para el administrador',
  })
  proposal!: DocumentProposalDto | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  proposalExpiresAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  attemptedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  decidedByUserId!: string | null;
  @ApiProperty({ type: String, nullable: true }) decisionNote!: string | null;
  @ApiProperty({
    type: () => DocumentReadingCorrectionDto,
    isArray: true,
    nullable: true,
  })
  corrections!: DocumentReadingCorrectionDto[] | null;
  @ApiProperty() executed!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  remindedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  escalatedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  reconciledAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiPropertyOptional({ type: DocumentReadingAttachmentDto })
  attachment?: DocumentReadingAttachmentDto;
}
export class DocumentReadingCorrectionDto {
  @ApiProperty() field!: string;
  @ApiProperty({ type: String, nullable: true }) read!: string | null;
  @ApiProperty() value!: string;
}
export class ConfirmDocumentReadingDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Obligatoria al confirmar una propuesta que registra un pago',
  })
  @IsOptional()
  @IsUUID()
  cashBoxId?: string;
}
export class CorrectDocumentReadingDto {
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  @IsObject()
  // Sin un tipo explícito, class-transformer toma `fields.constructor` como clase y tira
  // un TypeError (500) si el cuerpo trae esa clave.
  @Type(() => Object)
  fields!: Record<string, string>;
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Obligatoria al corregir una propuesta que registra un pago',
  })
  @IsOptional()
  @IsUUID()
  cashBoxId?: string;
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
export class RejectDocumentReadingDto {
  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class DocumentReadingListDto {
  @ApiProperty({ type: DocumentReadingDto, isArray: true })
  data!: DocumentReadingDto[];

  @ApiProperty()
  total!: number;
}

export class DocumentReadingSpendDto {
  @ApiProperty({
    description:
      'Intentos de lectura con consumo este mes, incluidos los que fallaron (los duplicados no cuentan)',
  })
  readings!: number;

  @ApiProperty({ description: 'Gasto estimado del mes en dólares' })
  costUsd!: number;

  @ApiProperty({ description: 'Si el servicio de lectura está configurado' })
  available!: boolean;
}

export class RunDocumentReadingsDto {
  @ApiPropertyOptional({
    description:
      'Con true sólo cuenta los adjuntos que leería, sin descargar ni leer archivos',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class DocumentReadingRunDto {
  @ApiProperty() distributors!: number;
  @ApiProperty() read!: number;
  @ApiProperty() duplicates!: number;
  @ApiProperty() failed!: number;
  @ApiProperty() skipped!: number;
  @ApiProperty() budgetReached!: number;
}
