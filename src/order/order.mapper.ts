import { Order, OrderStatus, PaymentType } from './entities/order.entity';
import { OrderResponseDto } from './dto/order-response.dto';
// import { plainToInstance } from 'class-transformer';

export class OrderMapper {
    static toDto(order: Order): OrderResponseDto {
        const dto = new OrderResponseDto();

        dto.id = order.order_id;
        dto.total = Number(order.totalAmount); // Ensure number
        dto.createdAt = order.createdAt;
        dto.deliveryNotes = order.deliveryInstructions || null;
        dto.customerNotes = order.notes || null;
        dto.deliveryId = order.delivery_id || null;
        dto.actualDeliveryDate = order.deliveredAt;

        // Delivery Name (if loaded)
        dto.deliveryName = order.delivery && order.delivery.user ? (order.delivery.user.full_name || null) : null;

        // Status Mapping
        dto.status = this.mapStatus(order.status);

        // Agendamiento + reserva
        dto.scheduledDate = order.scheduled_date ?? null;
        dto.depositAmount = Number(order.deposit_amount ?? 0);
        dto.depositPaid = !!order.deposit_paid;
        // Saldo a cobrar al entregar = total menos la seña YA paga.
        dto.remainingBalance =
            Number(order.totalAmount) - (order.deposit_paid ? dto.depositAmount : 0);

        // Payment Method Mapping
        dto.paymentMethod = this.mapPaymentType(order.paymentType);


        // Address Mapping
        if (order.address) {
            dto.address = {
                id: order.address.address_id,
                street: order.address.street,
                city: order.address.city,
                postalCode: order.address.postalCode,
                latitude: order.address.latitude,
                longitude: order.address.longitude,
                formattedAddress: order.address.formattedAddress,
                additionalInstructions: order.address.additionalInstructions,
            };
        } else {
            dto.address = null;
        }

        // TimeSlot Flattening
        if (order.timeSlot) {
            dto.deliveryWindowStart = order.timeSlot.startTime;
            dto.deliveryWindowEnd = order.timeSlot.endTime;
            // Use current date combined with time for requestedDeliveryDate if needed, 
            // or just leave it null if not explicitly tracked as a separate date column.
            // For now, let's leave requestedDeliveryDate null or map if available.
            // The entity doesn't seem to have a specific 'requestedDate' column other than 'createdAt' or 'timeSlot'.
            dto.requestedDeliveryDate = null;
        } else {
            dto.deliveryWindowStart = null;
            dto.deliveryWindowEnd = null;
            dto.requestedDeliveryDate = null;
        }

        // Items Mapping
        dto.items = order.items ? order.items.map(item => ({
            quantity: item.quantity,
            cylinder: item.gasCylinder ? {
                id: item.gasCylinder.gas_cylinder_id,
                type: item.gasCylinder.type,
                weight: Number(item.gasCylinder.weight),
                price: Number(item.gasCylinder.price),
                description: item.gasCylinder.description,
            } : null,
        })) as any : []; // Type assertion to match DTO structure if needed, or refine

        return dto;
    }

    private static mapStatus(status: OrderStatus): string {
        switch (status) {
            case OrderStatus.PENDING:
                return 'pending';
            case OrderStatus.ACCEPTED:
                return 'accepted';
            case OrderStatus.ON_THE_WAY:
                return 'out_for_delivery'; // Mapped for Mobile App
            case OrderStatus.DELIVERED:
                return 'delivered';
            case OrderStatus.CANCELLED:
                return 'cancelled';
            default:
                return status;
        }
    }

    private static mapPaymentType(type: PaymentType): string {
        switch (type) {
            case PaymentType.CASH:
                return 'cash';
            case PaymentType.ONLINE:
                return 'online';
            default:
                return 'cash'; // Fallback
        }
    }
}
