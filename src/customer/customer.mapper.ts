import { latLngDesdePunto } from '../common/geo/punto';
import { Customer } from './entities/customer.entity';
import { CustomerResponseDto } from './dto/customer-response.dto';
import { UserMapper } from '../users/user.mapper';

export class CustomerMapper {
  static toDto(customer: Customer): CustomerResponseDto {
    const dto = new CustomerResponseDto();
    dto.customer_id = customer.customer_id;
    dto.user_id = customer.user_id;
    dto.lat_lang = latLngDesdePunto(customer.location);
    dto.validated = customer.validated;
    dto.createdAt = customer.createdAt;
    dto.deletedAt = customer.deletedAt;
    if (customer.user) dto.user = UserMapper.toDto(customer.user);
    return dto;
  }
}
