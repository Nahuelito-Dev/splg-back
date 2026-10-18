import { ApiProperty } from '@nestjs/swagger';
import { MaxLength } from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';

export class RejectLeaveDto {
  @ApiProperty({ example: 'Sin cobertura esa semana', maxLength: 500 })
  @TextoNoVacio()
  @MaxLength(500)
  reason!: string;
}
