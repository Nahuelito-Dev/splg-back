import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID, IsOptional, IsString, IsLatLong } from 'class-validator';

export class CreateCustomerDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  user_id!: string;

  @ApiPropertyOptional({ description: 'Token de FCM del dispositivo' })
  @IsOptional()
  @IsString()
  notification_token?: string;

  @ApiPropertyOptional({ example: '-27.3671,-55.8961' })
  @IsOptional()
  @IsLatLong({
    message:
      'lat_lang debe ser "latitud,longitud", por ejemplo -27.3671,-55.8961',
  })
  lat_lang?: string;
}
