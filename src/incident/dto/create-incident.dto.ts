import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsUUID, MaxLength } from 'class-validator';
import { LARGO_DESCRIPCION } from '../../common/constants/largos-de-texto';
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

  @ApiProperty({
    example: 'El cliente no estaba en el domicilio',
    maxLength: LARGO_DESCRIPCION,
  })
  @TextoNoVacio()
  @MaxLength(LARGO_DESCRIPCION)
  description!: string;
}
