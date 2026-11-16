import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MinLength } from 'class-validator';

/**
 * Lo que se edita de un administrador por `PATCH /admin/:id`. El correo no
 * (es su identidad de acceso: `POST /email/change-email`), ni el rol, la
 * distribuidora, el bloqueo (`PATCH /users/:id/block`) o la foto (`/users/:id/photo`).
 */
export class UpdateAdminDto {
  @ApiPropertyOptional({ example: 'Ana Pérez', minLength: 2 })
  @IsOptional()
  @IsString()
  @MinLength(2)
  fullName?: string;

  @ApiPropertyOptional({ example: '+5493764000000' })
  @IsOptional()
  @Matches(/^\+[1-9]\d{7,14}$/, {
    message: 'phoneNumber debe estar en formato E.164 (p. ej. +5493764000000)',
  })
  phoneNumber?: string;
}
