import { RoleType } from '../constants/role-type.enum';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';

/** Si el usuario es administrador (de una distribuidora o de la plataforma). */
export function esAdministrador(user: AuthenticatedUser): boolean {
  return user.role === RoleType.ADMIN || user.role === RoleType.SUPER_ADMIN;
}

/**
 * Propiedad del dato (anti-IDOR): el `user_id` contra el que un servicio tiene
 * que controlar que el recurso sea de quien pide, o `undefined` si pide un
 * administrador, que accede a cualquiera.
 */
export function alcanceDelDueño(user: AuthenticatedUser): string | undefined {
  return esAdministrador(user) ? undefined : user.user_id;
}
