import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsPhoneNumber, ValidateIf } from 'class-validator';

/**
 * Consulta de existencia previa al registro.
 *
 * Hace falta al menos uno de los dos campos: preguntar sin datos no tiene
 * sentido y antes devolvía `{exists:false}` como si la respuesta fuera útil.
 */
export class CheckUserExistsDto {
  @ApiPropertyOptional({ description: 'Correo a consultar' })
  @ValidateIf((o: CheckUserExistsDto) => !o.phoneNumber)
  @IsEmail({}, { message: 'email debe ser un correo válido' })
  email?: string;

  @ApiPropertyOptional({
    description: 'Teléfono a consultar, en formato E.164',
  })
  @ValidateIf((o: CheckUserExistsDto) => !o.email)
  @IsPhoneNumber(undefined, {
    message: 'phoneNumber debe ser un teléfono válido en formato E.164',
  })
  phoneNumber?: string;
}
