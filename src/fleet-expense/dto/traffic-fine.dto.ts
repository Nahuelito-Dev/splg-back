import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
  PickType,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { MotivoObligatorio } from '../../purchase/dto/motivo.decorator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import {
  FechaCalendario,
  FechaCalendarioOpcional,
} from '../../employee/dto/fecha-calendario.decorator';
import { VacioANulo } from '../../employee/dto/vacio-a-nulo.decorator';
import { TrafficFineStatus } from '../entities/traffic-fine.entity';

export class CreateTrafficFineDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  carId!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Cuándo ocurrió la infracción',
  })
  @IsDateString()
  occurredAt!: string;

  @ApiProperty({ example: 'Municipalidad de Posadas', maxLength: 80 })
  @TextoNoVacio()
  @MaxLength(80)
  jurisdiction!: string;

  @ApiProperty({
    example: 'A-0012345',
    maxLength: 40,
    description: 'Único por distribuidora y jurisdicción',
  })
  @TextoNoVacio()
  @MaxLength(40)
  actNumber!: string;

  @ApiProperty({ example: 'Exceso de velocidad' })
  @TextoNoVacio()
  @MaxLength(1000)
  infraction!: string;

  @ApiProperty({ example: 85000 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  @ApiPropertyOptional({
    type: Number,
    example: 59500,
    nullable: true,
    description: 'Importe con pago voluntario; no puede superar `amount`',
  })
  @VacioANulo()
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  voluntaryPaymentAmount?: number | null;

  @FechaCalendarioOpcional('2026-11-15')
  dueDate?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Legajo responsable. Si falta, se deduce del chofer que tenía el vehículo en uso en el instante de la infracción',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

/** El vehículo y el responsable no se editan por acá: el responsable se cambia imputando (CU-200). */
export class UpdateTrafficFineDto extends PartialType(
  OmitType(CreateTrafficFineDto, ['carId', 'employeeId'] as const),
) {
  @ApiPropertyOptional({
    description: 'Pasa la multa de pendiente a apelada',
  })
  @IsOptional()
  @IsBoolean()
  appeal?: boolean;
}

export class VoidTrafficFineDto {
  @ApiProperty({ example: 'Acta labrada a otro vehículo' })
  @MotivoObligatorio()
  reason!: string;
}

export class PayTrafficFineDto {
  @FechaCalendario('2026-10-20')
  paidAt!: string;

  @ApiProperty({
    example: 59500,
    description: 'Lo efectivamente pagado (suele ser el del pago voluntario)',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  paidAmount!: number;
}

export class ChargeTrafficFineDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Legajo que asume la multa; por omisión, el responsable deducido al registrarla',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

export class QueryTrafficFineDto extends PickType(PaginationDto, [
  'limit',
  'offset',
] as const) {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  carId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ enum: TrafficFineStatus })
  @IsOptional()
  @IsEnum(TrafficFineStatus)
  status?: TrafficFineStatus;

  @FechaCalendarioOpcional('2026-10-01', undefined)
  from?: string;

  @FechaCalendarioOpcional('2026-10-31', undefined)
  to?: string;
}

export class TrafficFineResponseDto {
  @ApiProperty({ format: 'uuid' }) fineId!: string;
  @ApiProperty({ format: 'uuid' }) distributorId!: string;
  @ApiProperty({ format: 'uuid' }) carId!: string;
  @ApiProperty({ type: String, nullable: true }) carPatent!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  employeeId!: string | null;
  @ApiProperty({ type: String, nullable: true }) employeeName!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) occurredAt!: Date;
  @ApiProperty() jurisdiction!: string;
  @ApiProperty() actNumber!: string;
  @ApiProperty() infraction!: string;
  @ApiProperty() amount!: number;
  @ApiProperty({ type: Number, nullable: true })
  voluntaryPaymentAmount!: number | null;
  @ApiProperty({ type: String, nullable: true, example: '2026-11-15' })
  dueDate!: string | null;
  @ApiProperty({ enum: TrafficFineStatus }) status!: TrafficFineStatus;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  paidAt!: Date | null;
  @ApiProperty({ type: Number, nullable: true }) paidAmount!: number | null;
  @ApiProperty({
    description: 'La asume el chofer: no cuenta como costo del vehículo',
  })
  chargedToEmployee!: boolean;
  @ApiProperty({ type: String, nullable: true }) voidReason!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  voidedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
}

export class TrafficFinePageDto {
  @ApiProperty({ type: TrafficFineResponseDto, isArray: true })
  data!: TrafficFineResponseDto[];
  @ApiProperty({ example: 4 }) total!: number;
}
