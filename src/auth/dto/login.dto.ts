import { IsEmail, IsNotEmpty, IsString, IsOptional } from 'class-validator';

export class LoginDto {
  @IsNotEmpty()
  @IsEmail()
  email: string;

  @IsString()
  password: string;

  @IsOptional() // ← AGREGAR ESTO
  requestSource?: string;
}
