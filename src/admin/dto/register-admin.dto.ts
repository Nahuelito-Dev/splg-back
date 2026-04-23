// dto/register-admin.dto.ts
import { IsString, IsEmail, IsUUID } from 'class-validator';

export class RegisterAdminDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;

  @IsString()
  phone_number: string;

  @IsString()
  full_name: string;

  @IsUUID()
  role_id: string;
}
