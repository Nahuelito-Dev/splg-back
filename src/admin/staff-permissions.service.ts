import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { RoleType } from '../common/constants/role-type.enum';
import {
  ordenarPermisos,
  PERMISOS,
  permisosEfectivos,
  type Permiso,
} from '../common/permisos/catalogo';

/** Lo que el panel y el guard saben del usuario: su rol de personal y sus permisos efectivos. */
export interface PermisosDelUsuario {
  todos: boolean;
  rol: { staffRoleId: string; name: string; isSystem: boolean } | null;
  permisos: Permiso[];
}

const SIN_PERMISOS: PermisosDelUsuario = {
  todos: false,
  rol: null,
  permisos: [],
};

/**
 * Permisos efectivos del personal del panel (F37). El super admin los tiene
 * todos; el admin, los de su rol de personal (el de sistema, todos), con el
 * `ver` que implica cada `gestionar`.
 *
 * Sin caché: una consulta por request (`admin.user_id` es único y
 * `staff_role_id` es la clave del rol), así revocar un permiso o reasignar un
 * rol vale en la request siguiente, sin carreras de invalidación. Con
 * `manager` se lee dentro de la transacción de quien la pide.
 */
@Injectable()
export class StaffPermissionsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async deUsuario(
    userId: string,
    role: RoleType,
    manager: EntityManager = this.dataSource.manager,
    actuaComoEmpresaPropia = false,
  ): Promise<PermisosDelUsuario> {
    // El super admin dentro de una empresa propia de la plataforma es un admin
    // de esa empresa con todos los permisos (no tiene fila en `admin`).
    if (
      role === RoleType.SUPER_ADMIN ||
      (role === RoleType.ADMIN && actuaComoEmpresaPropia)
    ) {
      return { todos: true, rol: null, permisos: [...PERMISOS] };
    }
    if (role !== RoleType.ADMIN) return SIN_PERMISOS;

    // Un rol dado de baja no se carga: el admin queda sin permisos hasta que
    // le asignen otro.
    const filas: Array<{
      staff_role_id: string;
      name: string;
      is_system: boolean;
      permissions: string[];
    }> = await manager.query(
      `SELECT sr."staff_role_id", sr."name", sr."is_system", sr."permissions"
         FROM "admin" a
         JOIN "staff_role" sr ON sr."staff_role_id" = a."staff_role_id" AND sr."deletedAt" IS NULL
        WHERE a."user_id" = $1`,
      [userId],
    );
    const rol = filas[0];
    if (!rol) return SIN_PERMISOS;
    const resumen = {
      staffRoleId: rol.staff_role_id,
      name: rol.name,
      isSystem: rol.is_system,
    };
    if (rol.is_system) {
      return { todos: true, rol: resumen, permisos: [...PERMISOS] };
    }
    return {
      todos: false,
      rol: resumen,
      permisos: ordenarPermisos(permisosEfectivos(rol.permissions)),
    };
  }
}
