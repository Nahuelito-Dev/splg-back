import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class BuscarAdminParamDto {
  @ApiProperty({
    description: 'Id del administrador o correo de su usuario',
    example: 'admin@splg.com',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(254)
  term!: string;
}
