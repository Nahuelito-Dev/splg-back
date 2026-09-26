import {
  IsUUID,
  IsOptional,
  IsString,
  IsBoolean,
  IsLatLong,
} from 'class-validator';

export class CreateCustomerDto {
  @IsUUID()
  user_id!: string;

  @IsOptional()
  @IsString()
  notification_token?: string;

  @IsOptional()
  @IsLatLong({
    message:
      'lat_lang debe ser "latitud,longitud", por ejemplo -27.3671,-55.8961',
  })
  lat_lang?: string;

  @IsOptional()
  @IsBoolean({ message: 'validated tiene que ser true o false' })
  validated?: boolean;
}
