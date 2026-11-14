import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { RoleType } from '../constants/role-type.enum';
import type { Request } from 'express';

/**
 * Identidad del usuario autenticado, tal como la deja `AuthGuard` en
 * `request.user` tras verificar el ID token de Firebase y resolver el rol
 * contra la base de datos. Es la ÚNICA fuente de verdad de identidad/rol:
 * nunca deben leerse `userId`/`role` desde el body o los params (IDOR).
 */
export interface AuthenticatedUser {
  /** PK de la entidad `User` (así se guarda `order.customer_id`). */
  user_id: string;
  email: string;
  role: RoleType;
  /**
   * Tenant (distribuidora) efectivo de la request. Multi-tenant:
   *  - admin/delivery: su distribuidora, derivada del perfil (server-trusted).
   *  - customer: la del header `X-Distributor` si se envió.
   *  - super_admin: la de su sesión de soporte (`X-Support-Session`); sin
   *    sesión, `null` (plataforma). El `X-Distributor` no se lee.
   * Lo resuelve `AuthGuard`; nunca se lee del body.
   */
  distributor_id?: string | null;
  /**
   * Sesión de soporte con la que el super admin hace la request, si la hay. Con
   * ella ve la empresa como la ve un admin, en sólo lectura.
   */
  support_session_id?: string | null;
}

/**
 * Inyecta el usuario autenticado en el handler.
 *
 *   findMine(@CurrentUser() user: AuthenticatedUser) { ... }
 *   findMine(@CurrentUser('user_id') userId: string) { ... }
 *
 * Lanza 500 si se usa en una ruta sin `AuthGuard` (no debería pasar: el guard
 * es global). Es intencional: falla ruidoso antes que devolver `undefined`.
 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const user: AuthenticatedUser | undefined = request.user;

    if (!user) {
      throw new InternalServerErrorException(
        'CurrentUser usado en una ruta sin usuario autenticado (falta AuthGuard o @Public mal aplicado)',
      );
    }

    return data ? user[data] : user;
  },
);
