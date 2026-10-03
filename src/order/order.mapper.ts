import type { Point } from 'typeorm';
import { coordenadasDePunto } from '../common/geo/punto';
import { Order, OrderStatus, PaymentType } from './entities/order.entity';
import type { User } from '../users/entities/user.entity';
import {
  CustomerDeOrderDto,
  OrderItemResponseDto,
  OrderResponseDto,
  ProductoDelRenglonDto,
  VehicleDeOrderDto,
  ZoneSurchargeDto,
} from './dto/order-response.dto';

/** La dirección se guarda como punto; el pedido la muestra como texto. */
function latitudDe(punto: Point | null): string | null {
  const c = coordenadasDePunto(punto);
  return c ? String(c.lat) : null;
}

function longitudDe(punto: Point | null): string | null {
  const c = coordenadasDePunto(punto);
  return c ? String(c.lng) : null;
}

/**
 * Cliente del pedido, para el panel. `null` si la relación `order.customer`
 * no vino cargada (el repositorio no la pidió).
 */
function clienteDe(user: User | null | undefined): CustomerDeOrderDto | null {
  if (!user) return null;
  const dto = new CustomerDeOrderDto();
  dto.userId = user.userId;
  dto.fullName = user.fullName ?? null;
  dto.phoneNumber = user.phoneNumber ?? null;
  dto.email = user.email ?? null;
  return dto;
}

/**
 * Recargo por zona, tal como quedó en el snapshot del pedido. `null` si la
 * distribuidora no tenía zonas al pedir (no-op) o el pedido es anterior a esta
 * funcionalidad — en ambos casos `coverageZoneId` es `null`.
 */
function recargoDeZonaDe(order: Order): ZoneSurchargeDto | null {
  if (!order.coverageZoneId || !order.zoneSurchargeType) return null;
  const dto = new ZoneSurchargeDto();
  dto.coverageZoneId = order.coverageZoneId;
  dto.name = order.zoneName ?? '';
  dto.type = order.zoneSurchargeType;
  dto.value = Number(order.zoneSurchargeValue ?? 0);
  dto.amount = Number(order.zoneSurchargeAmount ?? 0);
  return dto;
}

/**
 * Vehículo con el que se entrega, tal como quedó en el snapshot del pedido
 * (tomado al aceptarlo). `null` si todavía no tiene chofer, o es de antes
 * de esta funcionalidad — en ambos casos `vehicleCarId` es `null`.
 */
function vehiculoDe(order: Order): VehicleDeOrderDto | null {
  if (!order.vehicleCarId) return null;
  const dto = new VehicleDeOrderDto();
  dto.carId = order.vehicleCarId;
  dto.patent = order.vehiclePatent ?? null;
  dto.brand = order.vehicleBrand ?? null;
  dto.model = order.vehicleModel ?? null;
  return dto;
}

export class OrderMapper {
  static toDto(order: Order): OrderResponseDto {
    const dto = new OrderResponseDto();

    dto.id = order.orderId;
    dto.distributorId = order.distributorId;
    dto.total = Number(order.totalAmount); // Ensure number
    dto.createdAt = order.createdAt;
    dto.deliveryNotes = order.deliveryInstructions || null;
    dto.customerNotes = order.notes || null;
    dto.deliveryId = order.deliveryId || null;
    dto.actualDeliveryDate = order.deliveredAt;

    // Delivery Name (if loaded)
    dto.deliveryName =
      order.delivery && order.delivery.user
        ? order.delivery.user.fullName || null
        : null;

    // Cliente (para el panel; null si la relación no vino cargada).
    dto.customer = clienteDe(order.customer);
    dto.cancellationReason = order.cancellationReason ?? null;
    dto.acceptedAt = order.acceptedAt ?? null;
    dto.onTheWayAt = order.onTheWayAt ?? null;

    // Zona de cobertura: snapshot al momento de pedir (no vuelve a leer la zona).
    dto.zoneSurcharge = recargoDeZonaDe(order);
    dto.subtotalItems = Number(order.subtotalItems ?? 0);
    dto.vehicle = vehiculoDe(order);

    // Status Mapping
    dto.status = this.mapStatus(order.status);

    // Agendamiento + reserva
    dto.scheduledDate = order.scheduledDate ?? null;
    dto.depositAmount = Number(order.depositAmount ?? 0);
    dto.depositPaid = !!order.depositPaid;
    // Saldo a cobrar al entregar = total menos la seña YA paga.
    dto.remainingBalance =
      Number(order.totalAmount) - (order.depositPaid ? dto.depositAmount : 0);

    // Payment Method Mapping
    dto.paymentMethod = this.mapPaymentType(order.paymentType);

    // Address Mapping
    if (order.address) {
      dto.address = {
        id: order.address.addressId,
        street: order.address.street,
        city: order.address.city,
        postalCode: order.address.postalCode,
        latitude: latitudDe(order.address.location),
        longitude: longitudDe(order.address.location),
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

    dto.items = (order.items ?? []).map((item) => {
      const renglon = new OrderItemResponseDto();
      renglon.quantity = item.quantity;
      renglon.unitPrice = Number(item.unitPrice);
      renglon.subtotal = Number(item.subtotal);
      renglon.cylinder = null;
      if (item.gasCylinder) {
        const producto = new ProductoDelRenglonDto();
        producto.id = item.gasCylinder.gasCylinderId;
        producto.type = item.gasCylinder.type;
        producto.weight = Number(item.gasCylinder.weight);
        producto.price = Number(item.gasCylinder.price);
        producto.description = item.gasCylinder.description;
        renglon.cylinder = producto;
      }
      return renglon;
    });

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
