import { ApiProperty } from '@nestjs/swagger';
import { UserResponseDto } from './user-response.dto';

/** Una página de usuarios y el total que coincide con la búsqueda. */
export class ListadoDeUsuariosDto {
  @ApiProperty({ type: UserResponseDto, isArray: true })
  users!: UserResponseDto[];

  @ApiProperty({ description: 'Total de usuarios que cumplen el filtro' })
  maxUsers!: number;
}

/** Si un correo o un teléfono ya están en uso. Sólo booleanos: es público. */
export class UsuarioExisteDto {
  @ApiProperty()
  exists!: boolean;

  @ApiProperty({ description: 'El correo consultado ya está en uso' })
  email!: boolean;

  @ApiProperty({ description: 'El teléfono consultado ya está en uso' })
  phoneNumber!: boolean;
}

/** Resultado de bloquear o desbloquear una cuenta. */
export class BloqueoDeUsuarioDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, nullable: true })
  email!: string | null;

  @ApiProperty()
  isBlocked!: boolean;

  @ApiProperty({ example: 'Usuario bloqueado' })
  message!: string;
}
