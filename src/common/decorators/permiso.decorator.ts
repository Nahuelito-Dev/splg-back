import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiForbiddenResponse } from '@nestjs/swagger';
import {
  etiquetaDelPermiso,
  type Permiso as ClaveDePermiso,
} from '../permisos/catalogo';

export const PERMISO_KEY = 'permisos';

/**
 * Permiso del catálogo que exige el endpoint al personal del panel (F37). Va
 * junto a `@Auth(...)`, que sigue diciendo qué tipo de cuenta entra: el
 * `PermissionGuard` corre después de `RolesGuard` y sólo mira a los `admin`
 * (el `super_admin` pasa siempre; las cuentas de las apps no tienen rol de
 * personal). Con varios permisos alcanza con tener uno.
 *
 *   @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
 *   @Permiso('pedidos.gestionar')
 */
export function Permiso(
  ...permisos: [ClaveDePermiso, ...ClaveDePermiso[]]
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(PERMISO_KEY, permisos),
    ApiForbiddenResponse({
      description: `La cuenta no tiene el rol que pide el endpoint, o es un administrador cuyo rol de personal no tiene permiso para ${permisos
        .map((p) => `${etiquetaDelPermiso(p)} (\`${p}\`)`)
        .join(
          ' ni para ',
        )}. Super admin: los del modo soporte (\`SUPPORT_SESSION_REQUIRED\`, \`SUPPORT_READ_ONLY\`, \`SUPPORT_SESSION_ENDED\`, \`SUPPORT_SCOPE_REQUIRED\`)`,
    }),
  );
}
