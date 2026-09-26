import { Admin } from './entities/admin.entity';
import {
  AdminResponseDto,
  AdminVistaResponseDto,
} from './dto/admin-response.dto';
import { UserMapper } from '../users/user.mapper';
import { RoleMapper } from '../role/role.mapper';
import { DistributorMapper } from '../distributor/distributor.mapper';

export class AdminMapper {
  static toDto(admin: Admin): AdminResponseDto {
    const dto = new AdminResponseDto();
    dto.admin_id = admin.admin_id;
    dto.user_id = admin.user_id;
    // El rol es el del usuario: el perfil no lo repite.
    dto.role_id = admin.user?.role_id ?? null;
    dto.distributor_id = admin.distributor_id;
    dto.createdAt = admin.createdAt;
    if (admin.user) dto.user = UserMapper.toDto(admin.user);
    if (admin.user?.role) dto.role = RoleMapper.toDto(admin.user.role);
    if (admin.distributor) {
      dto.distributor = DistributorMapper.toDto(admin.distributor);
    }
    return dto;
  }

  static toVista(admin: Admin): AdminVistaResponseDto {
    const dto = new AdminVistaResponseDto();
    dto.admin_id = admin.admin_id;
    dto.email = admin.user?.email ?? null;
    dto.displayName = admin.user?.full_name ?? null;
    dto.fullName = admin.user?.full_name ?? null;
    dto.rol = admin.user?.role?.type ?? null;
    return dto;
  }
}
