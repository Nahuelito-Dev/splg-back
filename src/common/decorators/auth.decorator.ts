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
  return applyDecorators(
    Roles(...roles),
    ApiBearerAuth(),
    ApiUnauthorizedResponse({ description: 'Sin token o token inválido' }),
    ApiForbiddenResponse({
      description: `Requiere rol: ${roles.join(', ')}`,
    }),
  );
}
