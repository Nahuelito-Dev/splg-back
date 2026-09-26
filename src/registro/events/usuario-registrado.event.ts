import type { RolRegistrable } from '../politica-de-registro';

/** Nombre del evento que publica `registro` después de confirmar un alta. */
export const EVENTO_USUARIO_REGISTRADO = 'usuario.registrado';

/**
 * Se dio de alta un usuario y la transacción ya está confirmada. Lo que venga
 * después (el correo de bienvenida) lo escucha quien corresponda y nunca
 * deshace el alta.
 */
export class UsuarioRegistradoEvent {
  constructor(
    readonly userId: string,
    readonly email: string,
    readonly fullName: string,
    readonly rol: RolRegistrable,
  ) {}
}
