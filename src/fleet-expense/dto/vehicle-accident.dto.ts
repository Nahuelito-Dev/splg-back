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
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { FechaCalendarioOpcional } from '../../employee/dto/fecha-calendario.decorator';
import { VacioANulo } from '../../employee/dto/vacio-a-nulo.decorator';
import { VehicleAccidentStatus } from '../entities/vehicle-accident.entity';

const aBooleano = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

const LAT_LNG = /^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*$/;

export class CreateVehicleAccidentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  carId!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Cuándo ocurrió',
  })
  @IsDateString()
  occurredAt!: string;

  @ApiPropertyOptional({
    type: String,
    example: '-27.3671,-55.8961',
    nullable: true,
    description: 'Punto en el mapa, como "latitud,longitud"',
  })
  @VacioANulo()
  @IsOptional()
  @IsString()
  @Matches(LAT_LNG, { message: 'location: tiene que ser "latitud,longitud"' })
  location?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Ruta 12 km 1340',
  })
  @VacioANulo()
  @IsOptional()
  @TextoNoVacio()
  @MaxLength(300)
  address?: string | null;

  @ApiProperty({ example: 'Choque trasero en la esquina de Bolívar y Colón' })
  @TextoNoVacio()
  @MaxLength(2000)
  description!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  injuries?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  thirdPartiesInvolved?: boolean;

  @ApiPropertyOptional({
    description:
      'Fuga o derrame de gas: avisa de inmediato a los administradores',
  })
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  hazmatRelease?: boolean;

  @ApiPropertyOptional({ type: String, nullable: true })
  @VacioANulo()
  @IsOptional()
  @TextoNoVacio()
  @MaxLength(40)
  policeReportNumber?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @VacioANulo()
  @IsOptional()
  @TextoNoVacio()
  @MaxLength(40)
  insurerClaimNumber?: string | null;

  @ApiPropertyOptional({
    description:
      'Si quedó inutilizable, el vehículo pasa a fuera de servicio y se libera a su chofer',
  })
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  vehicleUnusable?: boolean;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Legajo de quien conducía; en el reporte del chofer es el suyo',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

export class CreateMyVehicleAccidentDto extends OmitType(
  CreateVehicleAccidentDto,
  ['carId', 'employeeId'] as const,
) {}

/**
 * Corrige los datos y avanza el ciclo. El vehículo, el conductor y si quedó
 * inutilizable no se cambian: el estado del vehículo se vuelve con CU-247.
 */
export class UpdateVehicleAccidentDto extends PartialType(
  OmitType(CreateVehicleAccidentDto, [
    'carId',
    'employeeId',
    'vehicleUnusable',
  ] as const),
) {
  @ApiPropertyOptional({
    enum: [VehicleAccidentStatus.UNDER_REVIEW, VehicleAccidentStatus.REPAIRING],
    description:
      'Sólo al estado siguiente del ciclo; el cierre es `PATCH …/close`',
  })
  @IsOptional()
  @IsEnum(VehicleAccidentStatus)
  status?: VehicleAccidentStatus;
}

export class CloseVehicleAccidentDto {
  @ApiProperty({ example: 350000, description: 'Costo de la reparación' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  repairCost!: number;

  @ApiProperty({ example: 250000, description: 'Lo que reintegró el seguro' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  insurerReimbursement!: number;

  @ApiProperty({
    example: 50000,
    description: 'Franquicia que pagó la distribuidora',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  deductibleAmount!: number;
}

export class QueryVehicleAccidentDto extends PickType(PaginationDto, [
  'limit',
  'offset',
] as const) {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  carId?: string;

  @ApiPropertyOptional({ enum: VehicleAccidentStatus })
  @IsOptional()
  @IsEnum(VehicleAccidentStatus)
  status?: VehicleAccidentStatus;

  @FechaCalendarioOpcional('2026-10-01', undefined)
  from?: string;

  @FechaCalendarioOpcional('2026-10-31', undefined)
  to?: string;
}

export class VehicleAccidentResponseDto {
  @ApiProperty({ format: 'uuid' }) accidentId!: string;
  @ApiProperty({ format: 'uuid' }) distributorId!: string;
  @ApiProperty({ format: 'uuid' }) carId!: string;
  @ApiProperty({ type: String, nullable: true }) carPatent!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  employeeId!: string | null;
  @ApiProperty({ type: String, nullable: true }) employeeName!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) occurredAt!: Date;
  @ApiProperty({ type: String, nullable: true, example: '-27.3671,-55.8961' })
  location!: string | null;
  @ApiProperty({ type: String, nullable: true }) address!: string | null;
  @ApiProperty() description!: string;
  @ApiProperty() injuries!: boolean;
  @ApiProperty() thirdPartiesInvolved!: boolean;
  @ApiProperty() hazmatRelease!: boolean;
  @ApiProperty({ type: String, nullable: true })
  policeReportNumber!: string | null;
  @ApiProperty({ type: String, nullable: true })
  insurerClaimNumber!: string | null;
  @ApiProperty({ enum: VehicleAccidentStatus }) status!: VehicleAccidentStatus;
  @ApiProperty() vehicleUnusable!: boolean;
  @ApiProperty({ type: Number, nullable: true }) repairCost!: number | null;
  @ApiProperty({ type: Number, nullable: true })
  insurerReimbursement!: number | null;
  @ApiProperty({ type: Number, nullable: true })
  deductibleAmount!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Costo de reparación menos reintegro del seguro; sólo cerrado',
  })
  netCost!: number | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
}

/** La respuesta del alta: el siniestro más lo que pasó con la asignación del vehículo. */
export class VehicleAccidentCreatedDto extends VehicleAccidentResponseDto {
  @ApiPropertyOptional({
    description:
      'Sólo en el alta: el vehículo quedó fuera de servicio pero su chofer lo sigue teniendo asignado (tiene un pedido en curso o una carga de camión abierta)',
  })
  assignmentKept?: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Sólo en el alta: por qué se mantuvo la asignación',
  })
  assignmentKeptReason?: string | null;
}

export class VehicleAccidentPageDto {
  @ApiProperty({ type: VehicleAccidentResponseDto, isArray: true })
  data!: VehicleAccidentResponseDto[];
  @ApiProperty({ example: 3 }) total!: number;
}
