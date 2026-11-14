import type { Reflector } from '@nestjs/core';
import { RoleType } from '../constants/role-type.enum';
import { ALCANCE_KEY, type Alcance } from '../decorators/alcance.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';

/** Lo que hace falta para leer la metadata de un endpoint (handler y su clase). */
export type Objetivos = [handler: object, clase: object];

/**
 * El alcance efectivo de un endpoint para el administrador general, o `null`
 * si no le aplica (público, o de roles que no lo incluyen: las apps).
 *
 * Regla por defecto, para no marcar a mano cientos de endpoints:
 *  - `@Public()` → no aplica.
 *  - `@Auth(...)` sin `super_admin` → no aplica (ya lo rechaza `RolesGuard`).
 *  - `@Alcance(...)` explícito (método o clase) → ese.
 *  - `@Auth(RoleType.SUPER_ADMIN)` solo → `plataforma`.
 *  - Todo lo demás → `empresa` (cerrado por defecto).
 */
export function resolverAlcance(
  reflector: Reflector,
  objetivos: Objetivos,
): Alcance | null {
  const [handler, clase] = objetivos;
  const lista = [handler, clase] as Array<() => void>;
  if (reflector.getAllAndOverride<boolean | undefined>('isPublic', lista)) {
    return null;
  }
  const roles = reflector.getAllAndOverride<RoleType[] | undefined>(
    ROLES_KEY,
    lista,
  );
  if (roles && roles.length > 0 && !roles.includes(RoleType.SUPER_ADMIN)) {
    return null;
  }
  const explicito = reflector.getAllAndOverride<Alcance | undefined>(
    ALCANCE_KEY,
    lista,
  );
  if (explicito) return explicito;
  if (roles?.length === 1) return 'plataforma';
  return 'empresa';
}
