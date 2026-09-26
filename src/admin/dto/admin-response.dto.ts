import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RoleResponseDto } from '../../role/dto/role-response.dto';
import { UserResponseDto } from '../../users/dto/user-response.dto';
import { DistributorResponseDto } from '../../distributor/dto/distributor-response.dto';

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
