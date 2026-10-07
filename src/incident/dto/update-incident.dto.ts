import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { IncidentType } from '../entities/incident.entity';

/** Lo editable de una incidencia abierta: su descripción y su tipo. */
export class UpdateIncidentDto {
  @ApiPropertyOptional({ example: 'El cliente no estaba en el domicilio' })
  @IsOptional()
  @TextoNoVacio()
  description?: string;

  @ApiPropertyOptional({ enum: IncidentType })
  @IsOptional()
  @IsEnum(IncidentType)
  type?: IncidentType;
}
