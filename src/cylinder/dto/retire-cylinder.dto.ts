import { ApiProperty } from '@nestjs/swagger';
import { MaxLength } from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';

export class RetireCylinderDto {
  @ApiProperty({
    example: 'Prueba hidráulica vencida, no apto',
    description: 'Motivo de la baja; queda en el historial del envase',
  })
  @TextoNoVacio()
  @MaxLength(500)
  reason!: string;
}
