import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CancelFleetTaskDto {
  @ApiPropertyOptional({ description: 'Por qué se cancela' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
