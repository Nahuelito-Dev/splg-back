import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'admin@splg.com' })
  @IsNotEmpty()
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Test1234' })
  @IsString()
  password!: string;

  /**
   * Se acepta por compatibilidad: algunas versiones de las apps lo mandan en el
   * cuerpo. El origen que vale es la cabecera X-Client-Source.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  requestSource?: string;
}
