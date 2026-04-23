import { IsUUID, IsOptional, IsString } from 'class-validator';

export class CreateCustomerDto {
  @IsUUID()
  user_id: string;

  @IsOptional()
  @IsString()
  notification_token?: string;

  @IsOptional()
  @IsString()
  lat_lang?: string;

  @IsOptional()
  @IsString()
  validated?: string;
}
