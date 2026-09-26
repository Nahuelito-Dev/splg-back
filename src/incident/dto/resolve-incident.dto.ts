import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class ResolveIncidentDto {
  @ApiProperty({ example: 'Se reprogramó la entrega' })
  @IsString()
  resolutionNote!: string;
}
