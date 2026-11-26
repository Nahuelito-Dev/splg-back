import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, Matches } from 'class-validator';
import { EsContrasenaSegura } from '../../common/validation/contrasena';

export class GrantEmployeeAccountDto {
  @ApiProperty({ example: 'ana@correo.com' })
  @IsEmail()
  email!: string;

  // Política: 8+ caracteres, una mayúscula, una minúscula y un número.
  @ApiProperty({
    example: 'Ejemplo2026x',
    minLength: 8,
    description:
      'De 8 a 128 caracteres, con una mayúscula, una minúscula y un número; no puede ser una contraseña común',
  })
  @IsString()
  @EsContrasenaSegura()
  password!: string;

  @ApiPropertyOptional({
    example: '+5493764000000',
    description:
      'Formato E.164. Si falta se usa el teléfono del legajo, que tiene que estar en ese formato',
  })
  @IsOptional()
  @Matches(/^\+[1-9]\d{7,14}$/, {
    message: 'phoneNumber tiene que estar en formato E.164 (+549...)',
  })
  phoneNumber?: string;
}
