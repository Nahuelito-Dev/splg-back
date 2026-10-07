import { ApiProperty } from '@nestjs/swagger';
import { MaxLength } from 'class-validator';
import { TextoNoVacio } from '../../common/decorators/texto-no-vacio.decorator';

/** Motivo de la moderación (ocultar o volver a mostrar una calificación). */
export class ModerateRatingDto {
  @ApiProperty({
    example: 'Lenguaje ofensivo en el comentario',
    description:
      'Obligatorio. Al ocultar queda guardado en la calificación; al ' +
      'volver a mostrarla queda en el registro de auditoría.',
  })
  @TextoNoVacio()
  @MaxLength(500)
  reason!: string;
}
