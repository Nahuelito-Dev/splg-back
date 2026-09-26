import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

/**
 * Lo que se puede cambiar de un usuario por `PATCH /users/:id`. El correo no:
 * es la identidad con la que entra, y cambia por `POST /email/change-email`,
 * que lo cambia también en el proveedor de identidad (H-73). Tampoco el rol ni
 * la cuenta de acceso.
 */
export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'Ana Pérez' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  full_name?: string;

  @ApiPropertyOptional({ example: '+5493764000000' })
  @IsOptional()
  @IsString()
  phone_number?: string;

  @ApiPropertyOptional({ description: 'URL de la foto del usuario' })
  @IsOptional()
  @IsString()
  selfie?: string;

  @ApiPropertyOptional({ description: 'Sólo administradores' })
  @IsOptional()
  @IsBoolean()
  blocked?: boolean;

  @ApiPropertyOptional({
    minLength: 6,
    description:
      'Sólo administradores: contraseña nueva, se cambia en el proveedor de ' +
      'identidad (H-75)',
  })
  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;
}
