import { latLngDesdePunto } from '../common/geo/punto';
import { Delivery } from './entities/delivery.entity';
import { DeliveryResponseDto } from './dto/delivery-response.dto';
import { UserMapper } from '../users/user.mapper';

export class DeliveryMapper {
  static toDto(d: Delivery): DeliveryResponseDto {
    const dto = new DeliveryResponseDto();
    dto.delivery_id = d.deliveryId;
    dto.distributor_id = d.distributorId;
    dto.user_id = d.userId;
    dto.calification = d.calification ?? null;
    dto.latLng = latLngDesdePunto(d.location);
    dto.actual_location = d.actualLocation ?? null;
    dto.cancelledCharge = d.cancelledCharge ?? null;
    dto.validated = d.validated;
    dto.isEnabled = d.isEnabled;
    dto.isAvailable = d.isAvailable;
    // Deprecado: alias de isEnabled por compatibilidad (ver el DTO).
    dto.isActive = d.isEnabled;
    dto.balance = d.balance;
    dto.createdAt = d.createdAt ?? null;
    dto.deletedAt = d.deletedAt ?? null;
    if (d.user) dto.user = UserMapper.toDto(d.user);
    return dto;
  }
}
