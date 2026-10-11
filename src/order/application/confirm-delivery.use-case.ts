import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';

import { Order, OrderStatus } from '../entities/order.entity';
import { RoleType } from '../../common/constants/role-type.enum';
import { compareDeliveryCode } from '../domain/delivery-code.util';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import { UpdateOrderStatusUseCase } from './update-order-status.use-case';

/**
 * Caso de uso: confirmación de entrega con QR (anti-fraude).
 *
 * El chofer llega y MUESTRA un QR con un código secreto (`order.deliveryCode`,
 * generado al ACEPTAR el pedido — ver UpdateOrderStatusUseCase). El cliente lo
 * escanea con su app y este use-case valida que el código coincida: si el
 * cliente conoce el código es porque vio el QR físico, es decir, el chofer
 * estuvo presente.
 *
 * La VALIDACIÓN del código vive acá. Los EFECTOS de pasar a DELIVERED
 * (timestamp, stopTracking del chofer, eventos de tiempo real)
 * se delegan en UpdateOrderStatusUseCase — el MISMO que usa el chofer/admin
 * en `PATCH :id/status` — para no duplicar esa lógica.
 */
@Injectable()
export class ConfirmDeliveryUseCase {
  constructor(
    private readonly orders: OrderRepositoryPort,
    private readonly updateOrderStatusUseCase: UpdateOrderStatusUseCase,
  ) {}

  async execute(
    orderId: string,
    code: string,
    userId: string,
    role: RoleType,
  ): Promise<Order> {
    const order = await this.orders.findByIdFull(orderId);
    if (!order)
      throw new NotFoundException(`Order with ID: ${orderId} not found`);

    // Ownership: un cliente solo puede confirmar SUS pedidos. Admin puede
    // confirmar cualquiera (soporte / entregas asistidas telefónicamente).
    if (role === RoleType.CUSTOMER && order.customerId !== userId) {
      throw new ForbiddenException(
        'No autorizado a confirmar la entrega de otro cliente',
      );
    }

    // Idempotencia: si ya está DELIVERED (reintento de red, doble escaneo,
    // botón apretado dos veces), no reprocesamos ni re-exigimos el código.
    if (order.status === OrderStatus.DELIVERED) {
      return order;
    }

    if (order.status !== OrderStatus.ON_THE_WAY) {
      throw new BadRequestException(
        'El pedido no está en camino, no se puede confirmar la entrega',
      );
    }

    if (!compareDeliveryCode(order.deliveryCode, code)) {
      throw new BadRequestException('Código de entrega inválido');
    }

    return this.updateOrderStatusUseCase.execute(
      order.orderId,
      OrderStatus.DELIVERED,
    );
  }
}
