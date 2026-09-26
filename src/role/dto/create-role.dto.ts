import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateRoleDto {
  @ApiProperty({ example: 'qa_pruebas' })
  @IsString()
  @IsNotEmpty()
  type!: string;
}
