import {
  CATALOGO_DE_PERMISOS,
  esPermiso,
  ordenarPermisos,
  permisoImplicado,
  PERMISOS,
} from '../common/permisos/catalogo';
import type { StaffRole } from './entities/staff-role.entity';
import type { PermisosDelUsuario } from './staff-permissions.service';
import type { AsignacionDeRol } from './staff-role.service';
import {
  AdminStaffRoleResponseDto,
  MyPermissionsResponseDto,
  PermissionModuleResponseDto,
  StaffRoleResponseDto,
  StaffRoleSummaryDto,
} from './dto/staff-role.dto';

export class StaffRoleMapper {
  static toDto(rol: StaffRole, adminCount: number): StaffRoleResponseDto {
    const dto = new StaffRoleResponseDto();
    dto.staffRoleId = rol.staffRoleId;
    dto.name = rol.name;
    dto.description = rol.description;
    dto.isSystem = rol.isSystem;
    // Lo elegido (sin los `ver` implícitos), filtrado por el catálogo vigente.
    // El de sistema, el catálogo entero.
    dto.permissions = rol.isSystem
      ? [...PERMISOS]
      : ordenarPermisos(rol.permissions.filter(esPermiso));
    dto.adminCount = adminCount;
    dto.createdAt = rol.createdAt;
    dto.updatedAt = rol.updatedAt;
    return dto;
  }

  static toSummary(rol: {
    staffRoleId: string;
    name: string;
    isSystem: boolean;
  }): StaffRoleSummaryDto {
    const dto = new StaffRoleSummaryDto();
    dto.staffRoleId = rol.staffRoleId;
    dto.name = rol.name;
    dto.isSystem = rol.isSystem;
    return dto;
  }

  static toAsignacion(asignacion: AsignacionDeRol): AdminStaffRoleResponseDto {
    const dto = new AdminStaffRoleResponseDto();
    dto.adminId = asignacion.adminId;
    dto.userId = asignacion.userId;
    dto.staffRole = StaffRoleMapper.toSummary(asignacion.rol);
    return dto;
  }

  static toMisPermisos(
    role: string,
    permisos: PermisosDelUsuario,
  ): MyPermissionsResponseDto {
    const dto = new MyPermissionsResponseDto();
    dto.role = role;
    dto.allPermissions = permisos.todos;
    dto.staffRole = permisos.rol
      ? StaffRoleMapper.toSummary(permisos.rol)
      : null;
    dto.permissions = [...permisos.permisos];
    return dto;
  }

  static toCatalogo(): PermissionModuleResponseDto[] {
    return CATALOGO_DE_PERMISOS.map((modulo) => ({
      key: modulo.clave,
      label: modulo.etiqueta,
      permissions: modulo.permisos.map((p) => {
        const implicado = permisoImplicado(p.clave);
        return {
          key: p.clave,
          label: p.etiqueta,
          description: p.descripcion,
          implies: implicado ? [implicado] : [],
        };
      }),
    }));
  }
}
