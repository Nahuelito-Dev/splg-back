import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { IncidentType } from '../entities/incident.entity';

export class CreateIncidentDto {
  /** Pedido sobre el que se reporta la incidencia. */
  @IsUUID()
  orderId: string;

  @IsEnum(IncidentType)
  type: IncidentType;

  @IsString()
  description: string;

  @IsOptional()
  @IsString()
  photoUrl?: string;
}
