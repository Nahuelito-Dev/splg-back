import { IsEmail, IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body de `POST /email/change-email`. Reemplaza el tipo inline
 * `{ currentEmail; newEmail; idToken }` sin cambiar el shape que espera el front.
 */
export class ChangeEmailDto {
  @ApiProperty({ example: 'old@example.com' })
  @IsEmail({}, { message: 'currentEmail debe ser un correo válido' })
  currentEmail!: string;

  @ApiProperty({ example: 'new@example.com' })
  @IsEmail({}, { message: 'newEmail debe ser un correo válido' })
  newEmail!: string;

  @ApiProperty({ description: 'Firebase ID token del usuario autenticado' })
  @IsString()
  @IsNotEmpty()
  idToken!: string;
}
