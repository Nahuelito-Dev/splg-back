import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { FechaCalendarioOpcional } from '../../employee/dto/fecha-calendario.decorator';
import { VacioANulo } from '../../employee/dto/vacio-a-nulo.decorator';
import { InstallmentStatus } from '../domain/insurance.enums';

export class UpdateInsuranceInstallmentDto {
  @FechaCalendarioOpcional('2026-11-22', undefined)
  dueDate?: string;

  @FechaCalendarioOpcional('2026-11-27', undefined)
  graceUntil?: string;

  @ApiPropertyOptional({ example: 31200 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount?: number;
}

export class PayInsuranceInstallmentDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Comprobante subido con `POST /insurance-installments/:id/receipt`',
  })
  @IsUUID()
  attachmentId!: string;

  @ApiProperty({
    type: String,
    example: '2026-11-20T14:30:00-03:00',
    description:
      'Cuándo se pagó (fecha o fecha y hora ISO 8601); no puede ser futura',
  })
  @IsISO8601({ strict: true })
  paidAt!: string;

  @ApiProperty({
    example: 29958,
    description:
      'Lo efectivamente pagado (puede diferir del importe de la cuota)',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '88123456',
    maxLength: 60,
  })
  @VacioANulo()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  operationNumber?: string | null;

  @ApiProperty({
    format: 'uuid',
    description:
      'Caja de la que sale el pago: efectivo, banco o billetera de la distribuidora',
  })
  @IsUUID()
  cashBoxId!: string;
}

export class QueryInsuranceInstallmentDto extends PaginationDto {
  @ApiPropertyOptional({ enum: InstallmentStatus })
  @IsOptional()
  @IsEnum(InstallmentStatus)
  status?: InstallmentStatus;

  @FechaCalendarioOpcional('2026-11-01', undefined)
  dueFrom?: string;

  @FechaCalendarioOpcional('2026-11-30', undefined)
  dueTo?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  carId?: string;
}

export class ReceiptScanDataDto {
  @ApiProperty({ type: String, nullable: true, example: '29958.00' })
  amount!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-11-20T14:30:00-03:00',
  })
  paidAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  operationNumber!: string | null;

  @ApiProperty({ type: String, nullable: true })
  payee!: string | null;

  @ApiProperty({ type: String, nullable: true })
  payeeTaxId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-11' })
  period!: string | null;

  @ApiProperty({ enum: ['high', 'medium', 'low'] })
  confidence!: 'high' | 'medium' | 'low';

  @ApiProperty({ type: [String] })
  warnings!: string[];
}

export class ReceiptScanDto {
  @ApiProperty({
    description:
      '`false` si no hay lector de comprobantes configurado: los datos se cargan a mano',
  })
  available!: boolean;

  @ApiProperty({
    type: ReceiptScanDataDto,
    nullable: true,
    description:
      'Lo que se leyó, para precargar el formulario; `null` si no hay lector o no se pudo leer',
  })
  data!: ReceiptScanDataDto | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Aviso cuando el lector estaba disponible pero falló o tardó más de 30 s: el comprobante quedó guardado y los datos se cargan a mano',
  })
  warning?: string | null;
}

export class UploadedReceiptDto {
  @ApiProperty({ format: 'uuid' })
  attachmentId!: string;

  @ApiProperty({ type: ReceiptScanDto })
  scan!: ReceiptScanDto;
}
