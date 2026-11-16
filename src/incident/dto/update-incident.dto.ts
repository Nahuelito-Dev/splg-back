import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, MaxLength } from 'class-validator';
import { LARGO_DESCRIPCION } from '../../common/constants/largos-de-texto';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { IncidentType } from '../entities/incident.entity';

/** Lo editable de una incidencia abierta: su descripción y su tipo. */
export class UpdateIncidentDto {
  @ApiPropertyOptional({
    example: 'El cliente no estaba en el domicilio',
    maxLength: LARGO_DESCRIPCION,
  })
  @IsOptional()
  @TextoNoVacio()
  @MaxLength(LARGO_DESCRIPCION)
  description?: string;

  @ApiPropertyOptional({ enum: IncidentType })
  @IsOptional()
  @IsEnum(IncidentType)
  type?: IncidentType;
}
