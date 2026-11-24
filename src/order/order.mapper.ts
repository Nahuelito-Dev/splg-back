import type { Point } from 'typeorm';
import { coordenadasDePunto } from '../common/geo/punto';
import { Order, OrderStatus, PaymentType } from './entities/order.entity';
import { esEditable } from './domain/order-editable';
import { efectivoACobrar } from './domain/efectivo-a-cobrar';
import type { User } from '../users/entities/user.entity';
import {
  CustomerDeOrderDto,
  DeliveryConfirmationDto,
  OrderItemResponseDto,
  OrderResponseDto,
  ProductoDelRenglonDto,
  ReceiverDeOrderDto,
  RevisitDeOrderDto,
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
  // La imagen la completa `OrderVehiclePhotoService` (el mapper no firma).
  dto.photoUrl = null;
  return dto;
}

/** Quién recibe, o `null` si no se indicó (o ya se anuló por plazo vencido). */
function receptorDe(order: Order): ReceiverDeOrderDto | null {
  if (
    !order.receiverName &&
    !order.receiverDocument &&
    !order.receiverRelationship
  ) {
    return null;
  }
  const dto = new ReceiverDeOrderDto();
  dto.name = order.receiverName ?? null;
  dto.document = order.receiverDocument ?? null;
  dto.relationship = order.receiverRelationship ?? null;
  return dto;
}

/**
 * `confirmedByUserId` es un dato interno (el usuario del chofer o del admin):
 * sólo sale para el personal del panel; al cliente y al chofer, `null`.
 */
function confirmacionDe(
  order: Order,
  paraElPersonal: boolean,
): DeliveryConfirmationDto | null {
  if (!order.deliveryConfirmedByUserId || !order.deliveredAt) return null;
  const punto = coordenadasDePunto(order.deliveryConfirmedPoint);
  const dto = new DeliveryConfirmationDto();
  dto.confirmedAt = order.deliveredAt;
  dto.confirmedByRole =
    (order.deliveryConfirmedByRole as DeliveryConfirmationDto['confirmedByRole']) ??
    null;
  dto.confirmedByUserId = paraElPersonal
    ? order.deliveryConfirmedByUserId
    : null;
  dto.latitude = punto?.lat ?? null;
  dto.longitude = punto?.lng ?? null;
  dto.accuracyMeters = order.deliveryConfirmedAccuracyM ?? null;
  dto.distanceMeters = order.deliveryConfirmedDistanceM ?? null;
  dto.outOfRange = !!order.deliveryConfirmedOutOfRange;
  return dto;
}

/**
 * La nueva visita (C5) mientras el pedido sigue abierto. El día y la franja son
 * los del pedido; con la decisión en manos del admin no se muestra fecha.
 */
function nuevaVisitaDe(order: Order): RevisitDeOrderDto | null {
  if (!order.revisitStatus) return null;
  if (
    order.status === OrderStatus.DELIVERED ||
    order.status === OrderStatus.CANCELLED
  ) {
    return null;
  }
  const decideElAdmin = order.revisitStatus === 'awaiting_admin';
  const dto = new RevisitDeOrderDto();
  dto.status = order.revisitStatus as RevisitDeOrderDto['status'];
  dto.failedVisitCount = order.failedVisitCount ?? 0;
  dto.scheduledDate = decideElAdmin ? null : (order.scheduledDate ?? null);
  dto.timeSlotId = decideElAdmin ? null : (order.timeSlotId ?? null);
  dto.timeSlotName = decideElAdmin ? null : (order.timeSlot?.name ?? null);
  dto.windowStart = decideElAdmin ? null : (order.timeSlot?.startTime ?? null);
  dto.windowEnd = decideElAdmin ? null : (order.timeSlot?.endTime ?? null);
  dto.canRespond =
    order.status === OrderStatus.PENDING &&
    !order.deliveryId &&
    order.revisitStatus === 'proposed';
  return dto;
}

export class OrderMapper {
  /**
   * `paraElPersonal`: la respuesta va a un admin o super admin (suma los datos
   * internos, como quién confirmó la entrega). Por omisión, la del cliente o el chofer.
   */
  static toDto(
    order: Order,
    { paraElPersonal = false }: { paraElPersonal?: boolean } = {},
  ): OrderResponseDto {
    const dto = new OrderResponseDto();

    dto.id = order.orderId;
    dto.distributorId = order.distributorId;
    dto.total = Number(order.totalAmount); // Ensure number
    dto.containerChargeAmount = Number(order.containerChargeAmount ?? 0);
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
    dto.receiver = receptorDe(order);
    // El chofer sólo se agrega en la lectura individual (ver `OrderService.getOne`).
    dto.driver = null;
    dto.deliveryConfirmation = confirmacionDe(order, paraElPersonal);
    dto.revisit = nuevaVisitaDe(order);
    dto.cancelledBy = null;

    // Status Mapping
    dto.status = this.mapStatus(order.status);

    // Agendamiento + reserva
    dto.scheduledDate = order.scheduledDate ?? null;
    dto.depositAmount = Number(order.depositAmount ?? 0);
    dto.depositPaid = !!order.depositPaid;
    // Saldo a cobrar al entregar = total menos la seña YA paga.
    dto.remainingBalance =
      Number(order.totalAmount) - (order.depositPaid ? dto.depositAmount : 0);

    dto.cashToCollect = efectivoACobrar({
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      status: order.status,
      total: Number(order.totalAmount),
      depositAmount: dto.depositAmount,
      depositPaid: dto.depositPaid,
    });

    // Payment Method Mapping
    dto.paymentMethod = this.mapPaymentType(order.paymentType);
    dto.paymentMethodDetail = order.paymentMethod;
    dto.paymentStatus = order.paymentStatus;
    dto.paymentConfirmedAt = order.paymentConfirmedAt ?? null;
    dto.paymentConfirmedBy = order.paymentConfirmedBy ?? null;
    dto.paymentResolvedAt = order.paymentResolvedAt ?? null;
    dto.paymentResolvedBy = order.paymentResolvedBy ?? null;
    dto.paymentResolutionNote = order.paymentResolutionNote ?? null;
    dto.editable = esEditable(order);
    dto.deliveryMode = order.deliveryMode;
    dto.expressSurchargeAmount = Number(order.expressSurchargeAmount ?? 0);
    dto.paymentSurchargeAmount = Number(order.paymentSurchargeAmount ?? 0);
    dto.paymentSurchargePercentage =
      order.paymentSurchargePercentage === null ||
      order.paymentSurchargePercentage === undefined
        ? null
        : Number(order.paymentSurchargePercentage);
    dto.expressDegradedAt = order.expressDegradedAt ?? null;

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
      renglon.containersCharged = Number(item.containersCharged ?? 0);
      renglon.emptiesExpected =
        item.quantity - Number(item.containersCharged ?? 0);
      renglon.emptiesReceived = item.emptiesReceived ?? null;
      renglon.containerUnitPrice =
        item.containerUnitPrice === null ||
        item.containerUnitPrice === undefined
          ? null
          : Number(item.containerUnitPrice);
      renglon.cylinder = null;
      if (item.gasCylinder) {
        const producto = new ProductoDelRenglonDto();
        producto.id = item.gasCylinder.gasCylinderId;
        producto.type = item.gasCylinder.type;
        producto.weight = Number(item.gasCylinder.weight);
        producto.price = Number(item.gasCylinder.price);
        producto.description = item.gasCylinder.description;
        producto.photoUrl = null;
        renglon.cylinder = producto;
      }
      return renglon;
    });

    return dto;
  }

  /** El estado como lo ven las apps (`on_the_way` sale como `out_for_delivery`). */
  static mapStatus(status: OrderStatus): string {
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
      case PaymentType.ACCOUNT:
        return 'account';
      default:
        return 'cash'; // Fallback
    }
  }
}
