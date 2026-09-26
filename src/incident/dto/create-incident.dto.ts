import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { IncidentType } from '../entities/incident.entity';

export class CreateIncidentDto {
  /** Pedido sobre el que se reporta la incidencia. */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  orderId!: string;

  @ApiProperty({ enum: IncidentType })
  @IsEnum(IncidentType)
  type!: IncidentType;

  @ApiProperty({ example: 'El cliente no estaba en el domicilio' })
  @IsString()
  description!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  photoUrl?: string;
}
