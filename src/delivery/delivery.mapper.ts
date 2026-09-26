import { latLngDesdePunto } from '../common/geo/punto';
import { Delivery } from './entities/delivery.entity';
import { DeliveryResponseDto } from './dto/delivery-response.dto';
import { UserMapper } from '../users/user.mapper';

export class DeliveryMapper {
  static toDto(d: Delivery): DeliveryResponseDto {
    const dto = new DeliveryResponseDto();
    dto.delivery_id = d.delivery_id;
    dto.distributor_id = d.distributor_id;
    dto.user_id = d.user_id;
    dto.calification = d.calification ?? null;
    dto.latLng = latLngDesdePunto(d.location);
    dto.actual_location = d.actual_location ?? null;
    dto.cancelledCharge = d.cancelledCharge ?? null;
    dto.validated = d.validated;
    dto.isActive = d.isActive;
    dto.balance = d.balance;
    dto.createdAt = d.createdAt ?? null;
    dto.deletedAt = d.deletedAt ?? null;
    if (d.user) dto.user = UserMapper.toDto(d.user);
    return dto;
  }
}
