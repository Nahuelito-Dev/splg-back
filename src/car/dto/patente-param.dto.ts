import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class PatenteParamDto {
  @ApiProperty({ example: 'AB104EJ' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  patent!: string;
}
