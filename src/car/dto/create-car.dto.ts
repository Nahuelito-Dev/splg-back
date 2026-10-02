// src/car/dto/create-car.dto.ts - VERSIÓN MEJORADA
import {
  IsUUID,
  IsOptional,
  IsString,
  IsInt,
  Matches,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { normalizarPatente } from '../patente.util';
import { ApiProperty } from '@nestjs/swagger';

export class CreateCarDto {
  @ApiProperty({ description: 'User ID' })
  @IsUUID()
  user_id!: string;

  @ApiProperty({
    description: 'Car type (Moto, Auto, Camioneta)',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  type_car?: string;

  @ApiProperty({ description: 'Car capacity in kg', required: false })
  @IsOptional()
  @IsInt()
  car_capacity?: number;

  @ApiProperty({
    description:
      'Patente. Se guarda en mayúsculas, sin espacios ni guiones, y tiene que ' +
      'quedar con al menos 4 letras o números. `null` (al editar) la borra.',
    required: false,
    nullable: true,
    type: String,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizarPatente(value) : value,
  )
  @IsString()
  @Matches(/^[A-Z0-9]{4,20}$/, {
    message:
      'car_patent debe tener entre 4 y 20 letras o números (sin contar espacios ni guiones)',
  })
  car_patent?: string | null;

  @ApiProperty({ description: 'Car brand', required: false })
  @IsOptional()
  @IsString()
  car_brand?: string;

  @ApiProperty({ description: 'Car model', required: false })
  @IsOptional()
  @IsString()
  car_model?: string;

  @ApiProperty({ description: 'Car year', required: false })
  @IsOptional()
  @IsInt()
  car_year?: number;

  @ApiProperty({ description: 'Car color', required: false })
  @IsOptional()
  @IsString()
  car_color?: string;
}
