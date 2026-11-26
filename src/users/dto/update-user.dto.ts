import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';
import { EsContrasenaSegura } from '../../common/validation/contrasena';

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
  @Matches(/^\+[1-9]\d{7,14}$/, {
    message: 'phone_number tiene que estar en formato E.164 (+549...)',
  })
  phone_number?: string;

  @ApiPropertyOptional({ description: 'Sólo administradores' })
  @IsOptional()
  @IsBoolean()
  blocked?: boolean;

  @ApiPropertyOptional({
    minLength: 8,
    description:
      'Sólo administradores: contraseña nueva (de 8 a 128 caracteres, con una mayúscula, una minúscula y un número; no puede ser común), se cambia en el proveedor de ' +
      'identidad (H-75)',
  })
  @IsOptional()
  @IsString()
  @EsContrasenaSegura()
  password?: string;
}
