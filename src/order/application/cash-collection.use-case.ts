import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../entities/order.entity';

/** Cómo cierra el administrador un cobro en efectivo impago. */
export type ResolucionDeImpago = 'paid' | 'written_off';

/** Resultado de una operación de cobro: el pedido y si el estado cambió. */
export interface ResultadoDeCobro<T = undefined> {
  order: Order;
  /** `false` cuando era un reintento y el pedido ya estaba en el estado pedido. */
  changed: boolean;
  /** Lo que devolvió el trabajo adicional de la misma transacción, si hubo. */
  extra: T;
}

/**
 * Caso de uso: el cobro de un pedido en EFECTIVO una vez entregado.
 *
 * Entregar no es cobrar: al pasar a DELIVERED el pago queda PENDING y recién
 * cuando el chofer confirma que cobró pasa a PAID (`confirmReceived`), o
 * informa que el cliente no pagó (`markUnpaid`, queda UNPAID y la incidencia
 * la abre el módulo `incident`). Un administrador cierra el impago como
 * cobrado después o como pérdida (`resolveUnpaid`).
 *
 * Cada operación corre en UNA transacción con lock pesimista sobre el pedido
 * y re-chequea estado y pago ya dentro del lock; se guarda con `save` (la
 * entidad cargada) para que el subscriber de auditoría registre quién y qué
 * cambió. Repetir la misma operación es un no-op (`changed: false`).
 */
@Injectable()
export class CashCollectionUseCase {
  constructor(private readonly dataSource: DataSource) {}

  /** El chofer asignado confirma que cobró el efectivo. */
  async confirmReceived(
    orderId: string,
    driverUserId: string,
  ): Promise<ResultadoDeCobro> {
    return this.dataSource.transaction(async (manager) => {
      const order = await this.lockPedidoDelChofer(
        manager,
        orderId,
        driverUserId,
      );
      if (order.paymentStatus === PaymentStatus.PAID) {
        return { order, changed: false, extra: undefined as never };
      }
      if (order.paymentStatus !== PaymentStatus.PENDING) {
        throw new ConflictException(
          'El pago de este pedido ya se informó como impago: lo resuelve un administrador',
        );
      }
      order.paymentStatus = PaymentStatus.PAID;
      order.paymentConfirmedAt = new Date();
      order.paymentConfirmedBy = driverUserId;
      return {
        order: await manager.save(order),
        changed: true,
        extra: undefined as never,
      };
    });
  }

  /**
   * El chofer asignado informa que el cliente no pagó el efectivo.
   * `dentro` corre en la MISMA transacción y con el pedido bloqueado, también
   * en un reintento (así lo que cuelga del impago, como su incidencia, se
   * crea o se encuentra una sola vez aunque lleguen varios avisos a la vez).
   */
  async markUnpaid<T>(
    orderId: string,
    driverUserId: string,
    dentro: (manager: EntityManager, order: Order) => Promise<T>,
  ): Promise<ResultadoDeCobro<T>> {
    return this.dataSource.transaction(async (manager) => {
      const order = await this.lockPedidoDelChofer(
        manager,
        orderId,
        driverUserId,
      );
      let changed = false;
      if (order.paymentStatus !== PaymentStatus.UNPAID) {
        if (order.paymentStatus !== PaymentStatus.PENDING) {
          throw new ConflictException(
            'El pago de este pedido ya no está pendiente: no se puede informar como impago',
          );
        }
        order.paymentStatus = PaymentStatus.UNPAID;
        await manager.save(order);
        changed = true;
      }
      return { order, changed, extra: await dentro(manager, order) };
    });
  }

  /** El administrador cierra un impago: cobrado después o pérdida. */
  async resolveUnpaid(
    orderId: string,
    adminUserId: string,
    resolution: ResolucionDeImpago,
    note: string,
  ): Promise<ResultadoDeCobro> {
    return this.dataSource.transaction(async (manager) => {
      const order = await this.lock(manager, orderId);
      const destino =
        resolution === 'paid' ? PaymentStatus.PAID : PaymentStatus.WRITTEN_OFF;
      // Repetir la resolución es un no-op; un PAID que confirmó el chofer
      // (sin motivo de resolución) no es un impago resuelto.
      if (
        order.paymentStatus === destino &&
        order.paymentResolutionNote !== null
      ) {
        return { order, changed: false, extra: undefined as never };
      }
      if (order.paymentStatus !== PaymentStatus.UNPAID) {
        throw new ConflictException(
          'Sólo se resuelve un pedido cuyo pago está informado como impago',
        );
      }
      order.paymentStatus = destino;
      order.paymentConfirmedAt = new Date();
      order.paymentConfirmedBy = adminUserId;
      order.paymentResolutionNote = note;
      return {
        order: await manager.save(order),
        changed: true,
        extra: undefined as never,
      };
    });
  }

  /**
   * Pedido bloqueado, y sólo si lo puede tocar este chofer, está entregado y
   * era en efectivo. El orden de los chequeos fija el código HTTP: pertenencia
   * (403) antes que estado y método (400).
   */
  private async lockPedidoDelChofer(
    manager: EntityManager,
    orderId: string,
    driverUserId: string,
  ): Promise<Order> {
    const order = await this.lock(manager, orderId);
    if (order.delivery?.userId !== driverUserId) {
      throw new ForbiddenException('Este pedido no está asignado a tu usuario');
    }
    if (order.status !== OrderStatus.DELIVERED) {
      throw new BadRequestException(
        'El cobro se informa sobre un pedido ya entregado',
      );
    }
    if (order.paymentMethod !== PaymentMethod.CASH) {
      throw new BadRequestException(
        'Sólo los pedidos en efectivo se cobran en la entrega',
      );
    }
    return order;
  }

  /** `FOR UPDATE OF "ord"`: el chofer es LEFT JOIN y no se puede bloquear. */
  private async lock(manager: EntityManager, orderId: string): Promise<Order> {
    const order = await manager
      .createQueryBuilder(Order, 'ord')
      .setLock('pessimistic_write', undefined, ['ord'])
      .leftJoinAndSelect('ord.delivery', 'delivery')
      .where('ord.orderId = :id', { id: orderId })
      .getOne();
    if (!order) {
      throw new NotFoundException(`Order with ID: ${orderId} not found`);
    }
    return order;
  }
}
