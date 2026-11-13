import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RoleResponseDto } from '../../role/dto/role-response.dto';
import { UserResponseDto } from '../../users/dto/user-response.dto';
import { DistributorResponseDto } from '../../distributor/dto/distributor-response.dto';

/** El rol de personal de un administrador, resumido para las listas del panel. */
export class AdminStaffRoleDto {
  @ApiProperty({ format: 'uuid' })
  staffRoleId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({
    description: 'Es el rol de sistema «Administrador» (todos los permisos)',
  })
  isSystem!: boolean;
}

export class AdminResponseDto {
  @ApiProperty({ format: 'uuid' })
  admin_id!: string;

  @ApiProperty({ format: 'uuid' })
  user_id!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  role_id!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Vacío: administrador de plataforma, sin distribuidora',
  })
  distributor_id!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiPropertyOptional({ type: UserResponseDto })
  user?: UserResponseDto;

  @ApiPropertyOptional({ type: RoleResponseDto })
  role?: RoleResponseDto;

  @ApiPropertyOptional({ type: DistributorResponseDto })
  distributor?: DistributorResponseDto;

  @ApiPropertyOptional({
    type: AdminStaffRoleDto,
    nullable: true,
    description:
      'Rol de personal del administrador (F37); null para el super admin',
  })
  staffRole?: AdminStaffRoleDto | null;
}

/** Vista resumida de un administrador, para buscarlo por id o por correo. */
export class AdminVistaResponseDto {
  @ApiProperty({ format: 'uuid' })
  admin_id!: string;

  @ApiProperty({ type: String, nullable: true })
  email!: string | null;

  @ApiProperty({ type: String, nullable: true })
  displayName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  fullName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'admin' })
  rol!: string | null;
}
