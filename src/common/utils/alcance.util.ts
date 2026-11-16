import { RoleType } from '../constants/role-type.enum';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';

/** Si el usuario es administrador (de una distribuidora o de la plataforma). */
export function esAdministrador(user: AuthenticatedUser): boolean {
  return user.role === RoleType.ADMIN || user.role === RoleType.SUPER_ADMIN;
}

/**
 * Si es el administrador general fuera del modo soporte y fuera de una empresa
 * propia: el único que ve lo de la plataforma. En una sesión de soporte o
 * operando una empresa propia ve la empresa como un admin de ella, así que los
 * privilegios de plataforma (ver otras empresas, el reporte de la cuenta
 * entera, registrar tokens de otro) no le corren.
 */
export function esSuperAdminDePlataforma(user: AuthenticatedUser): boolean {
  return user.role === RoleType.SUPER_ADMIN && !user.support_session_id;
}

/**
 * Propiedad del dato (anti-IDOR): el `user_id` contra el que un servicio tiene
 * que controlar que el recurso sea de quien pide, o `undefined` si pide un
 * administrador, que accede a cualquiera.
 */
export function alcanceDelDueño(user: AuthenticatedUser): string | undefined {
  return esAdministrador(user) ? undefined : user.user_id;
}

/**
 * Si el id (de una ruta o de un registro) es el del usuario autenticado. Los
 * UUID son iguales sin importar mayúsculas: `ParseUUIDPipe` deja pasar la ruta
 * tal como llegó, y comparar el texto dejaba escapar una auto-baja o un
 * auto-bloqueo escrito en mayúsculas.
 */
export function esElMismoUsuario(id: string, user: AuthenticatedUser): boolean {
  return id.toLowerCase() === user.user_id.toLowerCase();
}
