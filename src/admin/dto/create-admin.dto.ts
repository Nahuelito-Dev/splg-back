import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class CreateAdminDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  user_id!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  distributor_id?: string;
}
