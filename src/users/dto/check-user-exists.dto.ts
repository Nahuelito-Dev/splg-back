import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsString, Matches, ValidateIf } from 'class-validator';

/**
 * Consulta de existencia previa al registro.
 *
 * Hace falta al menos uno de los dos campos, y cada uno que viene se valida:
 * preguntar sin datos no tiene sentido, y un campo inválido no se ignora
 * porque el otro sea válido.
 */
export class CheckUserExistsDto {
  @ApiPropertyOptional({ description: 'Correo a consultar' })
  @ValidateIf(
    (o: CheckUserExistsDto) =>
      o.email !== undefined || o.phoneNumber === undefined,
  )
  @IsString({ message: 'email debe ser un correo válido' })
  @IsEmail({}, { message: 'email debe ser un correo válido' })
  email?: string;

  @ApiPropertyOptional({
    description: 'Teléfono a consultar, en formato E.164',
  })
  @ValidateIf(
    (o: CheckUserExistsDto) =>
      o.phoneNumber !== undefined || o.email === undefined,
  )
  @IsString({
    message: 'phoneNumber tiene que estar en formato E.164 (+549...)',
  })
  // La misma regla que el alta (`phone_number` en E.164): un teléfono que se
  // puede registrar no puede dar 400 al preguntar si ya existe.
  @Matches(/^\+[1-9]\d{7,14}$/, {
    message: 'phoneNumber tiene que estar en formato E.164 (+549...)',
  })
  phoneNumber?: string;
}
