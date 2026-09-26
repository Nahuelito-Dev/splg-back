import { IsEmail } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body de `POST /email/test`. Reemplaza el tipo inline `{ email: string }`.
 */
export class TestEmailDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail({}, { message: 'email debe ser un correo válido' })
  email!: string;
}
