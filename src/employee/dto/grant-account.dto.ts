import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';

export class GrantEmployeeAccountDto {
  @ApiProperty({ example: 'ana@correo.com' })
  @IsEmail()
  email!: string;

  // Firebase exige al menos 6 caracteres.
  @ApiProperty({ example: 'Test1234', minLength: 6 })
  @IsString()
  @MinLength(6)
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
