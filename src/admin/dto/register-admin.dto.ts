// dto/register-admin.dto.ts
import { IsString, IsEmail, IsUUID, IsOptional } from 'class-validator';

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

  /**
   * Distribuidora a la que pertenece el admin. Opcional: null = admin
   * cross-tenant (super_admin). El super_admin elige a qué empresa asignarlo.
   */
  @IsOptional()
  @IsUUID()
  distributorId?: string;
}
