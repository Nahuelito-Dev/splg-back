import { coordenadasDePunto } from '../common/geo/punto';
import { Order } from './entities/order.entity';
import { OrderRecordResponseDto } from './dto/order-record-response.dto';
import { UserMapper } from '../users/user.mapper';

export class OrderRecordMapper {
  static toDto(o: Order): OrderRecordResponseDto {
    const dto = new OrderRecordResponseDto();
    dto.order_id = o.orderId;
    dto.distributor_id = o.distributorId;
    dto.customer_id = o.customerId;
    dto.delivery_id = o.deliveryId;
    dto.time_slot_id = o.timeSlotId;
    dto.address_id = o.addressId;
    dto.scheduled_date = o.scheduledDate ?? null;
    dto.deposit_amount = o.depositAmount;
    dto.deposit_paid = o.depositPaid;
    dto.status = o.status;
    dto.paymentMethod = o.paymentMethod;
    dto.paymentType = o.paymentType;
    dto.paymentStatus = o.paymentStatus;
    dto.totalAmount = o.totalAmount;
    dto.notes = o.notes;
    dto.deliveryInstructions = o.deliveryInstructions;
    const destino = coordenadasDePunto(o.deliveryPoint);
    dto.deliveryLatitude = destino ? String(destino.lat) : null;
    dto.deliveryLongitude = destino ? String(destino.lng) : null;
    dto.acceptedAt = o.acceptedAt;
    dto.onTheWayAt = o.onTheWayAt;
    dto.deliveredAt = o.deliveredAt;
    dto.cancellationReason = o.cancellationReason;
    dto.gatewayPaymentId = o.gatewayPaymentId;
    dto.createdAt = o.createdAt;
    dto.updatedAt = o.updatedAt;
    if (o.customer) dto.customer = UserMapper.toDto(o.customer);
    return dto;
  }
}
