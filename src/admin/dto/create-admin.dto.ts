import { IsOptional, IsUUID } from 'class-validator';

export class CreateAdminDto {
  @IsUUID()
  user_id: string;

  @IsUUID()
  role_id: string;

  @IsOptional()
  @IsUUID()
  distributor_id?: string;
}
