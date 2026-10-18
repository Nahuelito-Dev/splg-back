import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { PaginationDto } from '../../common/dtos/pagination.dto';
import { TireEventType } from '../entities/tire-event.entity';
import { TireStatus } from '../entities/tire.entity';

export class CreateTireDto {
  @ApiProperty({
    example: 'DOT-4K2L-2326',
    maxLength: 60,
    description: 'Único por distribuidora',
  })
  @TextoNoVacio()
  @MaxLength(60)
  serialNumber!: string;

  @ApiProperty({ example: 'Pirelli', maxLength: 60 })
  @TextoNoVacio()
  @MaxLength(60)
  brand!: string;

  @ApiProperty({ example: '215/75 R17.5', maxLength: 40 })
  @TextoNoVacio()
  @MaxLength(40)
  size!: string;

  @ApiProperty({ example: 320000 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  cost!: number;
}

const POSICION = /^[A-Za-z0-9]{1,6}$/;

export class CreateTireEventDto {
  @ApiProperty({ enum: TireEventType })
  @IsEnum(TireEventType)
  type!: TireEventType;

  @ApiProperty({
    example: 120350,
    description: 'Kilometraje del vehículo en el movimiento',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  odometerKm!: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Vehículo; obligatorio en el montaje',
  })
  @IsOptional()
  @IsUUID()
  carId?: string;

  @ApiPropertyOptional({
    example: 'DI',
    description:
      'Código corto de la posición (p. ej. DI = delantero izquierdo); obligatorio en el montaje y la rotación',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(POSICION, {
    message: 'position: hasta 6 letras o números, por ejemplo DI',
  })
  position?: string;
}

export class QueryTireDto extends PickType(PaginationDto, [
  'limit',
  'offset',
] as const) {
  @ApiPropertyOptional({ enum: TireStatus })
  @IsOptional()
  @IsEnum(TireStatus)
  status?: TireStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  carId?: string;
}

export class TireEventResponseDto {
  @ApiProperty({ format: 'uuid' }) eventId!: string;
  @ApiProperty({ format: 'uuid' }) tireId!: string;
  @ApiProperty({ enum: TireEventType }) type!: TireEventType;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  carId!: string | null;
  @ApiProperty({ type: String, nullable: true }) position!: string | null;
  @ApiProperty() odometerKm!: number;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
}

export class TireResponseDto {
  @ApiProperty({ format: 'uuid' }) tireId!: string;
  @ApiProperty({ format: 'uuid' }) distributorId!: string;
  @ApiProperty() serialNumber!: string;
  @ApiProperty() brand!: string;
  @ApiProperty() size!: string;
  @ApiProperty() cost!: number;
  @ApiProperty({ enum: TireStatus }) status!: TireStatus;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  carId!: string | null;
  @ApiProperty({ type: String, nullable: true }) carPatent!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'DI' })
  position!: string | null;
  @ApiProperty({ type: Number, nullable: true }) mountedOdometerKm!:
    | number
    | null;
  @ApiProperty({ description: 'Km de los montajes ya cerrados' })
  kmTraveled!: number;
  @ApiProperty() retreadCount!: number;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiPropertyOptional({
    type: TireEventResponseDto,
    isArray: true,
    description:
      'Su historial, del más reciente al más antiguo (sólo al abrir un neumático)',
  })
  events?: TireEventResponseDto[];
}

export class TirePageDto {
  @ApiProperty({ type: TireResponseDto, isArray: true })
  data!: TireResponseDto[];
  @ApiProperty({ example: 8 }) total!: number;
}
