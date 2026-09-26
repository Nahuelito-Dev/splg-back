import { User } from './entities/user.entity';
import { UserResponseDto } from './dto/user-response.dto';
import { RoleMapper } from '../role/role.mapper';
import { UserAddressMapper } from '../user-address/user-address.mapper';
import { DeliveryMapper } from '../delivery/delivery.mapper';
import { CustomerMapper } from '../customer/customer.mapper';

export class UserMapper {
  static toDto(user: User): UserResponseDto {
    const dto = new UserResponseDto();
    dto.user_id = user.userId;
    dto.role_id = user.roleId ?? null;
    dto.full_name = user.fullName ?? null;
    dto.selfie = user.selfie ?? null;
    dto.email = user.email ?? null;
    dto.phone_number = user.phoneNumber ?? null;
    dto.phone_verified = user.phoneVerified;
    dto.email_verified = user.emailVerified;
    dto.blocked = user.blocked;
    dto.createdAt = user.createdAt;
    dto.deletedAt = user.deletedAt ?? null;
    if (user.role) dto.role = RoleMapper.toDto(user.role);
    if (user.addresses) {
      dto.addresses = user.addresses.map((a) => UserAddressMapper.toDto(a));
    }
    // La relación cargada puede venir vacía (el usuario no es chofer): se
    // conserva el null, igual que cuando salía la entidad.
    if (user.delivery !== undefined) {
      dto.delivery = user.delivery ? DeliveryMapper.toDto(user.delivery) : null;
    }
    if (user.customer !== undefined) {
      dto.customer = user.customer ? CustomerMapper.toDto(user.customer) : null;
    }
    return dto;
  }
}
