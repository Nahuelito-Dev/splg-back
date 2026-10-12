import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsUUID } from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
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
  @TextoNoVacio()
  description!: string;
}
