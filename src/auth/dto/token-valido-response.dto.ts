import { ApiProperty } from '@nestjs/swagger';

/**
 * Respuesta de `POST /auth`. Lo que informa es que la petición llegó al
 * controlador: el guard ya validó el token y la cuenta.
 *
 * Reproduce la forma que la API devolvía cuando el servicio respondía con una
 * `HttpException` como cuerpo (`response`, `status`, `message`, `name`), para
 * no cambiarle el contrato a quien la consuma. Una forma más limpia
 * (`{ valid: true }`) corresponde a `/v2`.
 */
export class TokenValidoResponseDto {
  @ApiProperty({ example: 'token valid' })
  response!: string;

  @ApiProperty({ example: 100 })
  status!: number;

  @ApiProperty({ example: 'token valid' })
  message!: string;

  @ApiProperty({ example: 'HttpException' })
  name!: string;

  static crear(): TokenValidoResponseDto {
    const dto = new TokenValidoResponseDto();
    dto.response = 'token valid';
    dto.status = 100;
    dto.message = 'token valid';
    dto.name = 'HttpException';
    return dto;
  }
}
