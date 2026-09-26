import { IsEmail } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body de `POST /email/password-reset`. Reemplaza el tipo inline
 * `{ email: string }` sin cambiar el shape que espera el front.
 */
export class SendPasswordResetDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail({}, { message: 'email debe ser un correo válido' })
  email!: string;
}
