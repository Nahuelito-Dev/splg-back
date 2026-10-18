import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
  PickType,
} from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { FuelType } from '../../car/entities/car.entity';
import { MAXIMO_ODOMETRO_KM } from '../../common/constants/odometro';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import {
  FechaCalendario,
  FechaCalendarioOpcional,
} from '../../employee/dto/fecha-calendario.decorator';
import { VacioANulo } from '../../employee/dto/vacio-a-nulo.decorator';
import { FuelPaymentMethod } from '../entities/fuel-load.entity';

const aBooleano = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

export class CreateFuelLoadDto {
  @ApiProperty({ format: 'uuid', description: 'Vehículo de la distribuidora' })
  @IsUUID()
  carId!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Cuándo se cargó; por omisión, ahora. No puede ser futura',
  })
  @IsOptional()
  @IsDateString()
  loadedAt?: string;

  @ApiPropertyOptional({
    enum: FuelType,
    description: 'Por omisión, el combustible del vehículo',
  })
  @IsOptional()
  @IsEnum(FuelType)
  fuelType?: FuelType;

  @ApiProperty({ example: 42.5, description: 'Litros cargados' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  liters!: number;

  @ApiProperty({ example: 1050.5, description: 'Precio por litro' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  unitPrice!: number;

  @ApiProperty({
    example: 44646.25,
    description:
      'Importe total; tiene que coincidir con litros × precio por litro, con una tolerancia del 1 %',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  totalAmount!: number;

  @ApiProperty({ example: 120350, description: 'Kilometraje del tablero' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAXIMO_ODOMETRO_KM)
  odometerKm!: number;

  @ApiPropertyOptional({
    description:
      'El consumo se mide entre cargas de tanque lleno (por omisión, sí)',
  })
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  isFullTank?: boolean;

  @ApiPropertyOptional({
    type: String,
    example: 'YPF Ruta 12',
    nullable: true,
  })
  @VacioANulo()
  @IsOptional()
  @TextoNoVacio()
  @MaxLength(120)
  station?: string | null;

  @ApiProperty({ enum: FuelPaymentMethod })
  @IsEnum(FuelPaymentMethod)
  paymentMethod!: FuelPaymentMethod;

  @ApiPropertyOptional({
    type: String,
    example: '0001-00012345',
    nullable: true,
  })
  @VacioANulo()
  @IsOptional()
  @TextoNoVacio()
  @MaxLength(40)
  receiptNumber?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @VacioANulo()
  @IsOptional()
  @TextoNoVacio()
  @MaxLength(2000)
  notes?: string | null;

  @ApiPropertyOptional({
    description:
      'Sólo el administrador: permite un kilometraje menor que el de la carga anterior. Exige `odometerCorrectionNote`',
  })
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  odometerCorrection?: boolean;

  @ApiPropertyOptional({
    description:
      'Por qué se fuerza el kilometraje (obligatoria con `odometerCorrection`)',
  })
  @IsOptional()
  @TextoNoVacio()
  @MaxLength(500)
  odometerCorrectionNote?: string;
}

/** La carga del chofer: siempre de su vehículo en uso y sin corrección de kilometraje. */
export class CreateMyFuelLoadDto extends OmitType(CreateFuelLoadDto, [
  'carId',
  'odometerCorrection',
  'odometerCorrectionNote',
] as const) {}

/** El vehículo no se cambia: si la carga era de otro, se anula y se registra de nuevo. */
export class UpdateFuelLoadDto extends PartialType(
  OmitType(CreateFuelLoadDto, ['carId'] as const),
) {}

export class QueryFuelLoadDto extends PickType(PaginationDto, [
  'limit',
  'offset',
] as const) {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  carId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Legajo de quien cargó' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @FechaCalendarioOpcional('2026-10-01', undefined)
  from?: string;

  @FechaCalendarioOpcional('2026-10-31', undefined)
  to?: string;

  @ApiPropertyOptional({
    description: 'Sólo las marcadas como anómalas (o sólo las que no)',
  })
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  anomaly?: boolean;
}

export class QueryRangeDto {
  @FechaCalendario('2026-10-01')
  from!: string;

  @FechaCalendario('2026-10-31')
  to!: string;
}

export class FuelLoadResponseDto {
  @ApiProperty({ format: 'uuid' }) fuelLoadId!: string;
  @ApiProperty({ format: 'uuid' }) distributorId!: string;
  @ApiProperty({ format: 'uuid' }) carId!: string;
  @ApiProperty({ type: String, nullable: true, example: 'AB123CD' })
  carPatent!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  employeeId!: string | null;
  @ApiProperty({ type: String, nullable: true })
  employeeName!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) loadedAt!: Date;
  @ApiProperty({ enum: FuelType }) fuelType!: FuelType;
  @ApiProperty() liters!: number;
  @ApiProperty() unitPrice!: number;
  @ApiProperty() totalAmount!: number;
  @ApiProperty() odometerKm!: number;
  @ApiProperty() isFullTank!: boolean;
  @ApiProperty({ type: String, nullable: true }) station!: string | null;
  @ApiProperty({ enum: FuelPaymentMethod }) paymentMethod!: FuelPaymentMethod;
  @ApiProperty({ type: String, nullable: true }) receiptNumber!: string | null;
  @ApiProperty({
    description: 'El consumo del tramo se apartó más de un 25 % del habitual',
  })
  anomaly!: boolean;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ type: String, nullable: true })
  odometerCorrectionNote!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  voidedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
}

export class FuelLoadPageDto {
  @ApiProperty({ type: FuelLoadResponseDto, isArray: true })
  data!: FuelLoadResponseDto[];
  @ApiProperty({
    example: 12,
    description: 'Cargas vigentes que cumplen los filtros, sin paginar',
  })
  total!: number;
  @ApiProperty({ example: 530.25, description: 'Litros de esas cargas' })
  totalLiters!: number;
  @ApiProperty({ example: 556762.5, description: 'Importe de esas cargas' })
  totalAmount!: number;
}

export class FuelTrancheDto {
  @ApiProperty({ format: 'uuid' }) fromLoadId!: string;
  @ApiProperty({ format: 'uuid' }) toLoadId!: string;
  @ApiProperty() fromKm!: number;
  @ApiProperty() toKm!: number;
  @ApiProperty() km!: number;
  @ApiProperty() liters!: number;
  @ApiProperty() amount!: number;
  @ApiProperty({ description: 'Rendimiento: km por litro' })
  kmPerLiter!: number;
  @ApiProperty({ description: 'Costo por km' }) costPerKm!: number;
}

export class FuelTotalsDto {
  @ApiProperty() km!: number;
  @ApiProperty() liters!: number;
  @ApiProperty() amount!: number;
  @ApiProperty({ type: Number, nullable: true }) kmPerLiter!: number | null;
  @ApiProperty({ type: Number, nullable: true }) costPerKm!: number | null;
}

export class FuelEfficiencyDto {
  @ApiProperty({ format: 'uuid' }) carId!: string;
  @ApiProperty({ example: '2026-10-01' }) from!: string;
  @ApiProperty({ example: '2026-10-31' }) to!: string;
  @ApiProperty({
    type: FuelTrancheDto,
    isArray: true,
    description: 'Vacío si en el rango hay menos de dos cargas de tanque lleno',
  })
  tranches!: FuelTrancheDto[];
  @ApiProperty({ type: FuelTotalsDto }) totals!: FuelTotalsDto;
  @ApiProperty({
    type: FuelLoadResponseDto,
    isArray: true,
    description: 'Las cargas del rango marcadas como anómalas',
  })
  anomalies!: FuelLoadResponseDto[];
}
