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
    dto.admin_id = admin.adminId;
    dto.user_id = admin.userId;
    // El rol es el del usuario: el perfil no lo repite.
    dto.role_id = admin.user?.roleId ?? null;
    dto.distributor_id = admin.distributorId;
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
    dto.admin_id = admin.adminId;
    dto.email = admin.user?.email ?? null;
    dto.displayName = admin.user?.fullName ?? null;
    dto.fullName = admin.user?.fullName ?? null;
    dto.rol = admin.user?.role?.type ?? null;
    return dto;
  }
}
