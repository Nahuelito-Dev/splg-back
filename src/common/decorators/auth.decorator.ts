import { applyDecorators } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleType } from '../constants/role-type.enum';
import { Roles } from './roles.decorator';

/**
 * Composición de decoradores (patrón de la documentación de Nest,
 * "Decorator composition"): restringe el endpoint a esos roles y lo documenta
 * en Swagger con el token y las respuestas 401 y 403.
 *
 *   @Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
 *
 * La autenticación no la hace este decorador: el AuthGuard es global y todo
 * endpoint nace protegido. Esto agrega la autorización por rol.
 */
export function Auth(...roles: RoleType[]): MethodDecorator & ClassDecorator {
  // Con los cuatro roles el 403 por rol no puede pasar: no se documenta (el 403
  // por pertenencia, si lo hay, lo declara el endpoint).
  const abiertoATodos = Object.values(RoleType).every((r) => roles.includes(r));
  return applyDecorators(
    Roles(...roles),
    ApiBearerAuth(),
    ApiUnauthorizedResponse({ description: 'Sin token o token inválido' }),
    ...(abiertoATodos
      ? []
      : [
          ApiForbiddenResponse({
            description: descripcionDel403(roles),
          }),
        ]),
  );
}

/**
 * El 403 por rol y, si el super admin entra, los del modo soporte: en lo de una
 * empresa sin sesión de soporte, o escribiendo con una (sólo lectura).
 */
function descripcionDel403(roles: RoleType[]): string {
  const porRol = `Requiere rol: ${roles.join(', ')}`;
  const soloPlataforma =
    roles.length === 1 && roles[0] === RoleType.SUPER_ADMIN;
  if (!roles.includes(RoleType.SUPER_ADMIN) || soloPlataforma) return porRol;
  return `${porRol}. Super admin: sin sesión de soporte en lo de una empresa (\`SUPPORT_SESSION_REQUIRED\`), escribiendo en modo soporte (\`SUPPORT_READ_ONLY\`) o con una sesión pendiente, vencida o revocada en \`X-Support-Session\` (\`SUPPORT_SESSION_ENDED\`), o un archivo o exporte sin ese alcance en la sesión (\`SUPPORT_SCOPE_REQUIRED\`)`;
}
