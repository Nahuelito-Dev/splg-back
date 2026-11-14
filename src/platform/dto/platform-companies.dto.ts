import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { DistributorStatus } from '../../distributor/entities/distributor.entity';

/** `'true'`/`'false'` de la query a booleano; cualquier otra cosa no valida. */
const aBooleano = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/** Filtros y paginación de `GET /v2/platform/companies`. */
export class QueryPlatformCompaniesDto {
  @ApiPropertyOptional({
    description:
      'true: sólo las empresas propias de la plataforma; false: sólo las de clientes',
  })
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  ownedByPlatform?: boolean;

  @ApiPropertyOptional({ enum: DistributorStatus })
  @IsOptional()
  @IsEnum(DistributorStatus)
  status?: DistributorStatus;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

/** Cuerpo de `PUT /v2/platform/companies/:id/owned-by-platform`. */
export class SetOwnedByPlatformDto {
  @ApiProperty({
    description:
      'true: la empresa pasa a ser propia de la plataforma (el administrador general la opera directo, sin sesión de soporte); false: vuelve a ser una empresa cliente',
  })
  @IsDefined()
  @IsBoolean()
  ownedByPlatform!: boolean;
}

/** Una empresa vista desde la plataforma (sin datos bancarios ni credenciales). */
export class PlatformCompanyDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Distribuidora de prueba OrixTech' })
  name!: string;

  @ApiProperty({ example: 'prueba-orixtech' })
  slug!: string;

  @ApiProperty({ enum: DistributorStatus })
  status!: DistributorStatus;

  @ApiProperty({
    description:
      'Empresa propia de la plataforma: el administrador general la opera con `X-Distributor`, sin sesión de soporte',
  })
  ownedByPlatform!: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;
}

export class PlatformCompanyListDto {
  @ApiProperty({ type: PlatformCompanyDto, isArray: true })
  items!: PlatformCompanyDto[];

  @ApiProperty({ example: 3 })
  total!: number;
}
