import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Filtros de `GET /audit/entries`. */
export class QueryAuditEntriesDto {
  @ApiPropertyOptional({
    example: 'Order',
    description: 'entidadAfectada: nombre de la entidad de dominio',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  entity?: string;

  @ApiPropertyOptional({
    description: 'idRegistro: id del registro afectado',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  recordId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'idUsuario: quién hizo el cambio',
  })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({
    example: 2,
    description:
      'idTipoAuditoria: 1 Alta, 2 Modificación, 3 Baja lógica, 4 Reactivación, 5 Baja física',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  actionType?: number;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'fechaHora desde (inclusive)',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate({ message: 'from debe ser una fecha' })
  from?: Date;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'fechaHora hasta (inclusive)',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate({ message: 'to debe ser una fecha' })
  to?: Date;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;
}

/** TipoAccionAuditoria. */
export class AuditActionTypeDto {
  @ApiProperty({ example: 2, description: 'idTipoAuditoria' })
  id!: number;

  @ApiProperty({ example: 'Modificación', description: 'nombre' })
  name!: string;
}

/** Quién hizo el cambio. */
export class AuditUserDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ type: String, nullable: true })
  fullName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  email!: string | null;

  @ApiProperty({ description: 'El usuario fue dado de baja después' })
  deleted!: boolean;
}

/** DetalleAuditoria: un campo que cambió. */
export class AuditDetailDto {
  @ApiProperty({ format: 'uuid', description: 'idDetalleAuditoria' })
  auditDetailId!: string;

  @ApiProperty({ example: 'status', description: 'campo' })
  field!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'valorAnterior (null en una alta). Secretos: [oculto]',
  })
  oldValue!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'valorNuevo. Secretos: [oculto]',
  })
  newValue!: string | null;
}

/** Auditoria: un registro afectado, con sus campos cambiados. */
export class AuditEntryDto {
  @ApiProperty({ format: 'uuid', description: 'idAuditoria' })
  auditId!: string;

  @ApiProperty({
    type: AuditActionTypeDto,
    description: 'idTipoAuditoria con su nombre',
  })
  actionType!: AuditActionTypeDto;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'idUsuario; null si lo hizo el sistema (cron, seed)',
  })
  userId!: string | null;

  @ApiProperty({
    type: AuditUserDto,
    nullable: true,
    description:
      'Datos del usuario (aunque esté dado de baja, con `deleted`); null si lo hizo el sistema',
  })
  user!: AuditUserDto | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  distributorId!: string | null;

  @ApiProperty({ example: 'Order', description: 'entidadAfectada' })
  entity!: string;

  @ApiProperty({ description: 'idRegistro' })
  recordId!: string;

  @ApiProperty({ type: String, nullable: true, description: 'ipUsuario' })
  ip!: string | null;

  @ApiProperty({ type: String, format: 'date-time', description: 'fechaHora' })
  dateTime!: Date;

  @ApiProperty({ type: AuditDetailDto, isArray: true })
  details!: AuditDetailDto[];
}

export class AuditEntriesPageDto {
  @ApiProperty({ type: AuditEntryDto, isArray: true })
  data!: AuditEntryDto[];

  @ApiProperty({ description: 'Total que cumple el filtro, sin paginar' })
  total!: number;
}
