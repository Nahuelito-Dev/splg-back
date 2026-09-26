import { ApiProperty } from '@nestjs/swagger';

/**
 * Lo que el sistema sabe del usuario recién autenticado.
 *
 * Es deliberadamente chico: identifica a la persona y nada más. Todo lo demás
 * (roles, perfil, direcciones) se pide después con el token, a su endpoint.
 */
export class UsuarioAutenticadoDto {
  @ApiProperty({ description: 'Identificador del usuario en Firebase' })
  uid!: string;

  @ApiProperty({ description: 'Correo con el que inició sesión' })
  email!: string;

  @ApiProperty({ description: 'Nombre para mostrar', nullable: true })
  displayName!: string | null;

  @ApiProperty({ description: 'Teléfono verificado', nullable: true })
  phoneNumber!: string | null;

  @ApiProperty({ description: 'Si el correo está verificado' })
  emailVerified!: boolean;
}

/**
 * Respuesta del inicio de sesión.
 *
 * Devuelve **sólo el token de acceso**. No sale de acá el `refreshToken` —que
 * es de vida larga y permite emitir tokens nuevos—, ni la clave pública del
 * proyecto de Firebase, ni ningún campo interno del proveedor.
 *
 * Antes se devolvía el objeto `UserCredential` completo del SDK. Además de
 * filtrar esos datos, ese objeto tiene referencias circulares: no se podía
 * serializar sin que el proceso entrara en recursión infinita.
 */
export class SesionIniciadaDto {
  @ApiProperty({
    description: 'Token de acceso, para la cabecera Authorization',
  })
  accessToken!: string;

  @ApiProperty({ description: 'Segundos que dura el token', example: 3600 })
  expiresIn!: number;

  @ApiProperty({ type: UsuarioAutenticadoDto })
  user!: UsuarioAutenticadoDto;
}
