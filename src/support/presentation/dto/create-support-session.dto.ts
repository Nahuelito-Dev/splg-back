import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SupportScope } from '../../domain/support-session.enums';
import { DURACIONES_PERMITIDAS } from '../../domain/support-session.machine';
import { Recortar } from './recortar';

/** Pedido de acceso de soporte a una empresa (o acceso de emergencia). */
export class CreateSupportSessionDto {
  @ApiProperty({ format: 'uuid', description: 'La empresa (distribuidora)' })
  @IsUUID('4')
  distributorId!: string;

  @ApiProperty({
    minLength: 20,
    maxLength: 1000,
    example:
      'El admin reporta que los pedidos de hoy no aparecen en el tablero de despacho',
    description: 'Por qué hace falta mirar la empresa. Lo ve la empresa.',
  })
  @Recortar()
  @IsString()
  @Length(20, 1000)
  reason!: string;

  @ApiPropertyOptional({
    maxLength: 60,
    example: 'TICKET-1234',
    description: 'Referencia al pedido de ayuda, si existe',
  })
  @IsOptional()
  @Recortar()
  @IsString()
  @MaxLength(60)
  ticketRef?: string;

  @ApiPropertyOptional({
    enum: DURACIONES_PERMITIDAS,
    default: 60,
    description:
      'Duración en minutos: 15, 30, 60 o 120; en emergencia, hasta 60',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn(DURACIONES_PERMITIDAS)
  minutes: number = 60;

  @ApiPropertyOptional({
    enum: SupportScope,
    isArray: true,
    default: [],
    description:
      'Además de lo básico: `personal_data` (datos personales sin enmascarar), `files` (archivos) y `exports` (exportes)',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsEnum(SupportScope, { each: true })
  scope: SupportScope[] = [];

  @ApiPropertyOptional({
    default: false,
    description:
      'Acceso de emergencia: activo al instante, sin aprobación, con aviso inmediato a la empresa y hasta 60 minutos. La empresa puede deshabilitarlo.',
  })
  @IsOptional()
  @IsBoolean()
  emergency: boolean = false;
}
