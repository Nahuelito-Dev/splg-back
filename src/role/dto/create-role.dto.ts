import { IsString, IsOptional } from 'class-validator';

export class CreateRoleDto {
  @IsString()
  type: string;

  @IsOptional()
  @IsString()
  // si querés campos extra
  extra?: string;
}
