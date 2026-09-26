import { ApiProperty } from '@nestjs/swagger';

/** Respuesta de las operaciones que no devuelven un recurso: bajas, siembras. */
export class MessageResponseDto {
  @ApiProperty({ example: 'Role deleted successfully' })
  message!: string;

  static of(message: string): MessageResponseDto {
    const dto = new MessageResponseDto();
    dto.message = message;
    return dto;
  }
}
