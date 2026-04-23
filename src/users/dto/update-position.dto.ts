import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';

export class UpdatePositionDto {
  @ApiProperty({ description: 'Latitude and longitude coordinates' })
  @IsString()
  latLng: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  actualLocation?: string;
}
