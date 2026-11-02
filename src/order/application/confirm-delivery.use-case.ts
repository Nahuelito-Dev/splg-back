import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';

import { Order, OrderStatus } from '../entities/order.entity';
import { RoleType } from '../../common/constants/role-type.enum';
import {
  compareDeliveryCode,
  DeliveryCodeError,
  MAX_INTENTOS_CODIGO_ENTREGA,
  tieneFormatoDeCodigo,
} from '../domain/delivery-code.util';
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
    reason?: string,
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

    // Sólo cuentan (y se bloquean) los intentos del cliente: el admin que
    // entrega con motivo no queda trabado por los errores de nadie.
    const cuenta = role === RoleType.CUSTOMER;
    if (cuenta && order.deliveryCodeAttempts >= MAX_INTENTOS_CODIGO_ENTREGA) {
      throw this.codigoBloqueado();
    }

    if (!compareDeliveryCode(order.deliveryCode, code)) {
      if (cuenta) {
        const intentos = await this.orders.registerWrongDeliveryCode(
          order.orderId,
        );
        if (intentos >= MAX_INTENTOS_CODIGO_ENTREGA) {
          throw this.codigoBloqueado();
        }
      }
      throw await this.codigoRechazado(order, code, role);
    }

    // El admin que entrega por el QR (el código lo consigue con
    // `GET /:id/delivery-code`) deja asentado el motivo igual que por
    // `PATCH :id/status`: se le pasa el rol y el actor. El cliente confirma
    // sin rol: su escaneo es la prueba y `reason` se ignora.
    if (role === RoleType.ADMIN || role === RoleType.SUPER_ADMIN) {
      return this.updateOrderStatusUseCase.execute(
        order.orderId,
        OrderStatus.DELIVERED,
        undefined,
        role,
        userId,
        reason,
      );
    }
    return this.updateOrderStatusUseCase.execute(
      order.orderId,
      OrderStatus.DELIVERED,
    );
  }

  /** El 409 de un pedido cuyo código agotó los intentos. */
  private codigoBloqueado(): ConflictException {
    return new ConflictException({
      statusCode: 409,
      message: 'Demasiados intentos: pedile al chofer un código nuevo',
      error: 'Conflict',
      code: DeliveryCodeError.BLOQUEADO,
    });
  }

  /**
   * El 400 de un código que no es el del pedido, con `code` para que la app
   * diga por qué: mal leído, de otro pedido en camino del cliente, o
   * simplemente incorrecto. El `message` de siempre se conserva.
   */
  private async codigoRechazado(
    order: Order,
    code: string,
    role: RoleType,
  ): Promise<BadRequestException> {
    const motivo = await this.motivoDelRechazo(order, code, role);
    const message =
      motivo === DeliveryCodeError.FORMATO
        ? 'El código no tiene el formato de un código de entrega: revisá la lectura'
        : motivo === DeliveryCodeError.OTRO_PEDIDO
          ? 'Ese código es de otro de tus pedidos en camino'
          : 'Código de entrega inválido';
    return new BadRequestException({
      statusCode: 400,
      message,
      error: 'Bad Request',
      code: motivo,
    });
  }

  private async motivoDelRechazo(
    order: Order,
    code: string,
    role: RoleType,
  ): Promise<DeliveryCodeError> {
    if (!tieneFormatoDeCodigo(code)) return DeliveryCodeError.FORMATO;
    if (role === RoleType.CUSTOMER) {
      const enCamino = await this.orders.findOnTheWayByCustomer(
        order.customerId,
        order.distributorId,
      );
      const esDeOtro = enCamino.some(
        (o) =>
          o.orderId !== order.orderId &&
          compareDeliveryCode(o.deliveryCode, code),
      );
      if (esDeOtro) return DeliveryCodeError.OTRO_PEDIDO;
    }
    return DeliveryCodeError.INCORRECTO;
  }
}
