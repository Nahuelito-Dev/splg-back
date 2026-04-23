import { IsEmail, IsOptional, IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CompleteCustomerRegistrationDto {
  @ApiProperty({ description: 'User email' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ description: 'User password' })
  @IsString()
  @IsNotEmpty()
  password: string;

  @ApiProperty({ description: 'User full name' })
  @IsString()
  @IsNotEmpty()
  full_name: string;

  @ApiProperty({ description: 'User phone number' })
  @IsString()
  @IsNotEmpty()
  phone_number: string;

  @ApiProperty({ description: 'Customer notification token', required: false })
  @IsOptional()
  @IsString()
  notification_token?: string;

  @ApiProperty({ description: 'Customer location', required: false })
  @IsOptional()
  @IsString()
  lat_lang?: string;
}
