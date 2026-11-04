import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import {
  ImportFormat,
  ImportJobStatus,
  ImportResource,
} from '../domain/import.enums';

export class ImportTemplateQueryDto {
  @ApiProperty({
    enum: ImportFormat,
    required: false,
    default: ImportFormat.XLSX,
    description: 'Formato de la plantilla',
  })
  @IsOptional()
  @IsEnum(ImportFormat)
  format?: ImportFormat;
}

export class ImportErrorDto {
  @ApiProperty({
    example: 4,
    description: 'Fila del archivo (el encabezado es la 1)',
  })
  fila!: number;
  @ApiProperty({ example: 'Precio' }) columna!: string;
  @ApiProperty({ example: 'tiene que ser mayor que 0' }) mensaje!: string;
}

export class ImportPreviewRowDto {
  @ApiProperty({ example: 2 }) fila!: number;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { type: '10 kg', weight: 10, price: 12500.5, stock: 0 },
    description: 'La fila ya normalizada, como se va a aplicar',
  })
  datos!: Record<string, unknown>;
}

export class ImportPreviewResponseDto {
  @ApiProperty({ format: 'uuid' }) importId!: string;
  @ApiProperty({ enum: ImportResource }) recurso!: ImportResource;
  @ApiProperty({
    enum: ImportJobStatus,
    description:
      '`pending` se puede confirmar; `with_errors` no: se corrige el archivo y se vuelve a subir',
  })
  estado!: ImportJobStatus;
  @ApiProperty({ example: 120, description: 'Filas con datos del archivo' })
  total!: number;
  @ApiProperty({ example: 118 }) validas!: number;
  @ApiProperty({ type: ImportErrorDto, isArray: true })
  errores!: ImportErrorDto[];
  @ApiProperty({
    type: ImportPreviewRowDto,
    isArray: true,
    description: 'Las primeras 20 filas válidas, normalizadas',
  })
  vistaPrevia!: ImportPreviewRowDto[];
  @ApiProperty({ description: 'Hasta cuándo se puede confirmar (24 h)' })
  venceEn!: Date;
}

export class ImportConfirmResponseDto {
  @ApiProperty({ format: 'uuid' }) importId!: string;
  @ApiProperty({ enum: ImportResource }) recurso!: ImportResource;
  @ApiProperty({ enum: ImportJobStatus }) estado!: ImportJobStatus;
  @ApiProperty({ example: 120 }) total!: number;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { creadas: 120 },
    description: 'Cuánto se aplicó, por concepto (depende del recurso)',
  })
  resumen!: Record<string, number>;
  @ApiProperty() confirmadaEn!: Date;
  @ApiProperty({
    description:
      'true si esta importación ya estaba confirmada: no se aplicó de nuevo',
  })
  yaConfirmada!: boolean;
}
