import { User } from './entities/user.entity';
import { UserResponseDto } from './dto/user-response.dto';
import { RoleMapper } from '../role/role.mapper';
import { UserAddressMapper } from '../user-address/user-address.mapper';
import { DeliveryMapper } from '../delivery/delivery.mapper';
import { CustomerMapper } from '../customer/customer.mapper';

export class UserMapper {
  static toDto(user: User): UserResponseDto {
    const dto = new UserResponseDto();
    dto.user_id = user.user_id;
    dto.role_id = user.role_id ?? null;
    dto.full_name = user.full_name ?? null;
    dto.selfie = user.selfie ?? null;
    dto.email = user.email ?? null;
    dto.phone_number = user.phone_number ?? null;
    dto.phone_verified = user.phone_verified;
    dto.email_verified = user.email_verified;
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
