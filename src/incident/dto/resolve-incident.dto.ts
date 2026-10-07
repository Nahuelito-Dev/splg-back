import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';
import { IncidentStatus } from '../entities/incident.entity';

/** Cierres posibles: resolver (default) o descartar. */
const CIERRES = [IncidentStatus.RESOLVED, IncidentStatus.DISCARDED];

export class ResolveIncidentDto {
  @ApiProperty({
    example: 'Se reprogramó la entrega',
    description: 'Nota de resolución o motivo del descarte (obligatoria)',
  })
  @TextoNoVacio()
  resolutionNote!: string;

  @ApiPropertyOptional({
    enum: CIERRES,
    default: IncidentStatus.RESOLVED,
    description:
      '`resolved` (default) o `discarded`: descartar es la baja lógica de ' +
      'una incidencia abierta, con el motivo en `resolutionNote`',
  })
  @IsOptional()
  @IsIn(CIERRES, {
    message: `status debe ser uno de: ${CIERRES.join(', ')}`,
  })
  status?: IncidentStatus.RESOLVED | IncidentStatus.DISCARDED;
}
