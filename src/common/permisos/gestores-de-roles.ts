import { ConflictException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { RoleType } from '../constants/role-type.enum';
import { CODIGOS_DE_ERROR, conCodigo } from '../errors/con-codigo';
import { PERMISO_ROLES } from './catalogo';

/**
 * Regla de la distribuidora (F37): si alguien podía gestionar los roles,
 * alguien tiene que seguir pudiendo. La comparten los roles del personal
 * (editar un rol, asignarlo) y las cuentas (bloquear o dar de baja a un admin).
 * Lectura cruda de `admin`, `user` y `staff_role`: la misma excepción de
 * `common/tenancy/pertenencia.ts` (users no puede depender de admin).
 */

/**
 * Locks de la distribuidora, SIEMPRE en este orden en todos los caminos:
 * primero el de altas y bajas de admins (`admin-baja:<tenant>`, el que ya
 * toma `UsersService`) y después el de los roles (`staff-role:<tenant>`). Con
 * un orden único dos transacciones no pueden esperarse en cruz.
 */
export async function bloquearGestoresDeRoles(
  manager: EntityManager,
  distributorId: string,
  opciones: { yaTieneElDeBajas?: boolean } = {},
): Promise<void> {
  if (!opciones.yaTieneElDeBajas) {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `admin-baja:${distributorId}`,
    ]);
  }
  await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `staff-role:${distributorId}`,
  ]);
}

/**
 * Admins activos (sin baja, sin bloqueo, de tipo admin) con un rol vigente
 * que puede gestionar los roles (el de sistema, o uno con `roles.gestionar`).
 * Con `excluirUserId` cuenta como si ese usuario ya no estuviera.
 */
export async function contarGestoresDeRoles(
  manager: EntityManager,
  distributorId: string,
  excluirUserId: string | null = null,
): Promise<number> {
  const filas: { n: number }[] = await manager.query(
    `SELECT count(*)::int AS n FROM "admin" a
       JOIN "user" u ON u."user_id" = a."user_id" AND u."deletedAt" IS NULL AND u."blocked" = false
       JOIN "role" r ON r."role_id" = u."role_id" AND r."type" = $2
       JOIN "staff_role" sr ON sr."staff_role_id" = a."staff_role_id" AND sr."deletedAt" IS NULL
      WHERE a."distributor_id" = $1
        AND (sr."is_system" OR $3 = ANY(sr."permissions"))
        AND ($4::uuid IS NULL OR a."user_id" <> $4::uuid)`,
    [distributorId, RoleType.ADMIN, PERMISO_ROLES, excluirUserId],
  );
  return Number(filas[0]?.n ?? 0);
}

export const MENSAJE_ULTIMO_GESTOR_DE_ROLES =
  'Tiene que quedar al menos un administrador activo con permiso para gestionar los roles y permisos: asigná ese permiso a otro antes';

/**
 * Si antes había alguien que gestionaba los roles, después tiene que seguir
 * habiendo. Si antes ya no había nadie (una distribuidora sin admins, o con
 * todos bloqueados) el cambio no la empeora y pasa.
 */
export function assertQuedaQuienGestioneRoles(
  antes: number,
  despues: number,
): void {
  if (antes > 0 && despues === 0) {
    throw conCodigo(
      ConflictException,
      409,
      MENSAJE_ULTIMO_GESTOR_DE_ROLES,
      CODIGOS_DE_ERROR.LAST_ROLES_MANAGER,
    );
  }
}
