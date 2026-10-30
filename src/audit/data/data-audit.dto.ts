import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDate,
  IsIn,
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
    description:
      'Historial de un pedido: los asientos del Order, de sus renglones (OrderItem) y de sus pagos (Payment). Se combina con el resto de los filtros.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsUUID()
  orderId?: string;

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
      'idTipoAuditoria: 1 Alta, 2 Modificación, 3 Baja lógica, 4 Reactivación, 5 Baja física, 6 Ingreso, 7 Ingreso fallido, 8 Salida',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(8)
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

/** Quién (o qué) hizo el cambio, según la auditoría. */
export const ORIGENES_DE_AUDITORIA = ['user', 'system', 'direct'] as const;
export type OrigenDeAuditoria = (typeof ORIGENES_DE_AUDITORIA)[number];

/** Filtros de `GET /v2/audit/entries`: los de la v1 más el origen. */
export class QueryAuditEntriesV2Dto extends QueryAuditEntriesDto {
  @ApiPropertyOptional({
    enum: ORIGENES_DE_AUDITORIA,
    description:
      '`user`: lo hizo un usuario. `system`: sin usuario, hecho por la propia API (crons, procesos, ingresos fallidos). `direct`: sin usuario y escrito en la base por otra aplicación (SQL a mano, scripts de mantenimiento).',
  })
  @IsOptional()
  @IsIn(ORIGENES_DE_AUDITORIA)
  origin?: OrigenDeAuditoria;
}

/** Auditoria de la v2: la de la v1 más de dónde salió el asiento. */
export class AuditEntryV2Dto extends AuditEntryDto {
  @ApiProperty({
    enum: ORIGENES_DE_AUDITORIA,
    description: 'Ver el filtro `origin`',
  })
  origin!: OrigenDeAuditoria;

  @ApiProperty({
    example: 'db',
    description:
      '`db`: lo escribió el trigger de la tabla. `app`: lo asentó la API (ingresos, motivos)',
  })
  source!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Tabla que cambió (sólo asientos del trigger)',
  })
  tableName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Rol de la base que ejecutó el cambio',
  })
  dbUser!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'splg-api',
    description:
      'application_name de la conexión: `splg-api`, `splg-script:<nombre>`, `psql`...',
  })
  appName!: string | null;
}

export class AuditEntriesPageV2Dto {
  @ApiProperty({ type: AuditEntryV2Dto, isArray: true })
  data!: AuditEntryV2Dto[];

  @ApiProperty({ description: 'Total que cumple el filtro, sin paginar' })
  total!: number;
}
