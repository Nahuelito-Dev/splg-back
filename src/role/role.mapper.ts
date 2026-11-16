import { Role } from './entities/role.entity';
import { RoleResponseDto } from './dto/role-response.dto';

export class RoleMapper {
  static toDto(role: Role): RoleResponseDto {
    const dto = new RoleResponseDto();
    dto.role_id = role.roleId;
    dto.type = role.type;
    dto.createdAt = role.createdAt;
    dto.updatedAt = role.updatedAt;
    return dto;
  }
}
