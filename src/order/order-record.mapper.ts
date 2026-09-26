import { Order } from './entities/order.entity';
import { OrderRecordResponseDto } from './dto/order-record-response.dto';
import { UserMapper } from '../users/user.mapper';

export class OrderRecordMapper {
  static toDto(o: Order): OrderRecordResponseDto {
    const dto = new OrderRecordResponseDto();
    dto.order_id = o.order_id;
    dto.distributor_id = o.distributor_id;
    dto.customer_id = o.customer_id;
    dto.delivery_id = o.delivery_id;
    dto.time_slot_id = o.time_slot_id;
    dto.address_id = o.address_id;
    dto.scheduled_date = o.scheduled_date ?? null;
    dto.deposit_amount = o.deposit_amount;
    dto.deposit_paid = o.deposit_paid;
    dto.status = o.status;
    dto.paymentMethod = o.paymentMethod;
    dto.paymentType = o.paymentType;
    dto.paymentStatus = o.paymentStatus;
    dto.totalAmount = o.totalAmount;
    dto.notes = o.notes;
    dto.deliveryInstructions = o.deliveryInstructions;
    dto.deliveryLatitude = o.deliveryLatitude;
    dto.deliveryLongitude = o.deliveryLongitude;
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
