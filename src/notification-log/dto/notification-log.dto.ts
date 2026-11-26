import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { NotificationChannel, NotificationStatus } from '../domain/aviso';

/** Filtros del registro de avisos enviados. */
export class QueryNotificationLogDto {
  @ApiPropertyOptional({ enum: NotificationChannel })
  @IsOptional()
  @IsEnum(NotificationChannel)
  channel?: NotificationChannel;

  @ApiPropertyOptional({ enum: NotificationStatus })
  @IsOptional()
  @IsEnum(NotificationStatus)
  status?: NotificationStatus;

  @ApiPropertyOptional({
    example: 'ORDER_CONFIRMATION',
    description: 'Tipo exacto del aviso',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  type?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    description: 'Desde este día (inclusive, hora de Argentina)',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from debe ser YYYY-MM-DD' })
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    description: 'Hasta este día (inclusive, hora de Argentina)',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to debe ser YYYY-MM-DD' })
  @IsISO8601({ strict: true })
  to?: string;

  @ApiPropertyOptional({
    description: 'Parte del destinatario enmascarado o del asunto/título',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  term?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  offset?: number = 0;
}

export class NotificationLogItemDto {
  @ApiProperty({ format: 'uuid' })
  notificationLogId!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ enum: NotificationChannel })
  channel!: NotificationChannel;

  @ApiProperty({
    example: 'ORDER_CONFIRMATION',
    description: 'Tipo del aviso; `UNKNOWN` si quien envió no lo informó',
  })
  type!: string;

  @ApiProperty({
    example: 'n***@dominio.com',
    description: 'Correo enmascarado, o `***` más los últimos 6 del token',
  })
  recipientMasked!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Asunto del correo o título del push',
  })
  subject!: string | null;

  @ApiProperty({ enum: NotificationStatus })
  status!: NotificationStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Motivo corto cuando `status` es `failed` o `skipped`',
  })
  error!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  orderId!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      '`null` en los avisos que no se pudieron ubicar en una empresa',
  })
  distributorId!: string | null;
}

export class NotificationLogPageDto {
  @ApiProperty({ type: [NotificationLogItemDto] })
  data!: NotificationLogItemDto[];

  @ApiProperty({ example: 120 })
  total!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 0 })
  offset!: number;
}
