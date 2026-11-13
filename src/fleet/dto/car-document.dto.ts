import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { AttachmentResponseDto } from '../../attachment/dto/attachment-response.dto';
import { TipoDeDocumento } from '../../document-reader/tipos-de-documento';

export enum TipoDeDocumentoDeVehiculo {
  SEGURO = 'seguro',
  VTV = 'vtv',
  CEDULA = 'cedula',
  OTRO = 'otro',
}

export class UploadCarDocumentDto {
  @ApiProperty({ enum: TipoDeDocumentoDeVehiculo })
  @IsEnum(TipoDeDocumentoDeVehiculo)
  documentType!: TipoDeDocumentoDeVehiculo;
}

export class CarDocumentScanDataDto {
  @ApiProperty({ enum: TipoDeDocumento, nullable: true })
  detectedType!: TipoDeDocumento | null;
  @ApiProperty({ type: String, nullable: true, format: 'date' })
  expirationDate!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date' })
  issueDate!: string | null;
  @ApiProperty({ type: String, nullable: true }) insurer!: string | null;
  @ApiProperty({ type: String, nullable: true }) policyNumber!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'AB123CD' })
  patent!: string | null;
  @ApiProperty({ type: [String] }) warnings!: string[];
}

export class CarDocumentScanDto {
  @ApiProperty({ description: 'False si el lector no está configurado.' })
  available!: boolean;
  @ApiProperty({
    type: CarDocumentScanDataDto,
    nullable: true,
    description:
      'Lo leído para precargar el formulario; null sin lector o si no se pudo leer.',
  })
  data!: CarDocumentScanDataDto | null;
  @ApiPropertyOptional({
    type: String,
    description:
      'Presente si el escaneo falló o tardó demasiado: los datos se cargan a mano.',
  })
  warning?: string;
}

export class UploadedCarDocumentDto {
  @ApiProperty({ type: AttachmentResponseDto })
  attachment!: AttachmentResponseDto;
  @ApiProperty({ type: CarDocumentScanDto }) scan!: CarDocumentScanDto;
}

export class UploadedPatentPhotoDto extends UploadedCarDocumentDto {
  @ApiProperty({ description: 'True sólo si la patente leída no coincide.' })
  mismatch!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'AB123CD',
    description: 'Patente cargada en el vehículo.',
  })
  expectedPatent!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'AC456EF',
    description:
      'Patente leída en la foto, en mayúsculas y sin espacios ni guiones; null si no se pudo leer.',
  })
  readPatent!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Advertencia para mostrar si la patente leída no coincide (además queda un aviso en la bandeja).',
  })
  warning!: string | null;
}
