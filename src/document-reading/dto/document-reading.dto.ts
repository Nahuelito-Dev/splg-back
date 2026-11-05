import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

import { TipoDeDocumento } from '../../document-reader/tipos-de-documento';
import { DocumentReadingStatus } from '../entities/document-reading.entity';

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

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiPropertyOptional({ type: DocumentReadingAttachmentDto })
  attachment?: DocumentReadingAttachmentDto;
}

export class DocumentReadingListDto {
  @ApiProperty({ type: DocumentReadingDto, isArray: true })
  data!: DocumentReadingDto[];

  @ApiProperty()
  total!: number;
}

export class DocumentReadingSpendDto {
  @ApiProperty({
    description: 'Documentos leídos este mes (los duplicados no cuentan)',
  })
  readings!: number;

  @ApiProperty({ description: 'Gasto estimado del mes en dólares' })
  costUsd!: number;

  @ApiProperty({ description: 'Si el servicio de lectura está configurado' })
  available!: boolean;
}
