import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, FindOptionsWhere, In, Not, Repository } from 'typeorm';
import { Order, OrderStatus, PaymentStatus } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';

/** Lo mínimo de un pedido que necesitan los módulos que no son `order`. */
export interface OrderRef {
  orderId: string;
  customerId: string;
}

/** Estado de un pedido visto desde `payments`: si todavía se puede cobrar. */
export interface OrderPaymentState {
  status: OrderStatus;
  paymentStatus: PaymentStatus;
}

/**
 * Puerto de lectura de la tabla `order` para `cylinder`, `time-slot` y
 * `delivery`.
 *
 * `order` importa a esos dos módulos (reserva de franja, avance de envases al
 * entregar), así que ellos no pueden importar `OrderModule` sin armar un ciclo.
 * Este módulo no depende de nadie: `order` sigue siendo el único dueño de la
 * tabla y los demás le preguntan acá, siempre dentro de una distribuidora.
 */
@Injectable()
export class OrderLookupService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
  ) {}

  /**
   * El pedido dentro de la distribuidora, o null si no existe o es de otra.
   * Sin distribuidora (procesos internos sin contexto) busca sólo por id.
   */
  async findRef(
    orderId: string,
    distributorId?: string | null,
  ): Promise<OrderRef | null> {
    const where: FindOptionsWhere<Order> = { orderId };
    if (distributorId) where.distributorId = distributorId;
    const order = await this.orderRepository.findOne({
      where,
      select: { orderId: true, customerId: true },
    });
    return order
      ? { orderId: order.orderId, customerId: order.customerId }
      : null;
  }

  /** Estado y estado de pago del pedido, o null si no existe. */
  async findPaymentState(orderId: string): Promise<OrderPaymentState | null> {
    const order = await this.orderRepository.findOne({
      where: { orderId },
      select: { orderId: true, status: true, paymentStatus: true },
    });
    return order
      ? { status: order.status, paymentStatus: order.paymentStatus }
      : null;
  }

  /**
   * Pedidos no cancelados agendados en una franja y fecha. Con `manager` cuenta
   * dentro de esa transacción, para que vea el lock de la franja.
   */
  countBooked(
    timeSlotId: string,
    date: string,
    distributorId?: string | null,
    manager?: EntityManager,
  ): Promise<number> {
    const where: FindOptionsWhere<Order> = {
      timeSlotId,
      scheduledDate: date,
      status: Not(OrderStatus.CANCELLED),
    };
    if (distributorId) where.distributorId = distributorId;
    return manager
      ? manager.count(Order, { where })
      : this.orderRepository.count({ where });
  }

  /**
   * Mayor cantidad de pedidos no cancelados que tiene la franja en un mismo día
   * desde `desdeFecha` (inclusive): lo que la capacidad nunca puede bajar de.
   */
  async maxBookedFrom(
    timeSlotId: string,
    desdeFecha: string,
    manager: EntityManager,
  ): Promise<number> {
    const fila = await manager
      .createQueryBuilder(Order, 'o')
      .select('COUNT(*)', 'n')
      .where('o.timeSlotId = :timeSlotId', { timeSlotId })
      .andWhere('o.status != :cancelled', { cancelled: OrderStatus.CANCELLED })
      .andWhere('o.scheduledDate >= :desdeFecha', { desdeFecha })
      .groupBy('o.scheduledDate')
      .orderBy('n', 'DESC')
      .limit(1)
      .getRawOne<{ n: string }>();
    return fila ? Number(fila.n) : 0;
  }

  /** Pedidos que el chofer tiene tomados y todavía no entregó. */
  countActiveByDelivery(
    deliveryId: string,
    manager?: EntityManager,
  ): Promise<number> {
    const where: FindOptionsWhere<Order> = {
      deliveryId,
      status: In([OrderStatus.ACCEPTED, OrderStatus.ON_THE_WAY]),
    };
    return manager
      ? manager.count(Order, { where })
      : this.orderRepository.count({ where });
  }

  /**
   * Pedidos del cliente que todavía no terminaron (reservados, pendientes,
   * aceptados o en camino), de cualquier distribuidora: el cliente es uno solo
   * para todas.
   */
  countActiveByCustomer(
    customerId: string,
    manager?: EntityManager,
  ): Promise<number> {
    const where: FindOptionsWhere<Order> = {
      customerId,
      status: In([
        OrderStatus.RESERVED,
        OrderStatus.PENDING,
        OrderStatus.ACCEPTED,
        OrderStatus.ON_THE_WAY,
      ]),
    };
    return manager
      ? manager.count(Order, { where })
      : this.orderRepository.count({ where });
  }

  /**
   * Unidades de cada garrafa en pedidos abiertos (reservados, pendientes,
   * aceptados o en camino) de la distribuidora: lo que ya se descontó del
   * vendible y todavía no salió físicamente. Con `manager` lee dentro de esa
   * transacción.
   */
  async reservedByCylinder(
    distributorId: string,
    manager?: EntityManager,
  ): Promise<Map<string, number>> {
    const filas = await (manager ?? this.orderRepository.manager)
      .createQueryBuilder(OrderItem, 'item')
      .innerJoin('item.order', 'ord')
      .select('item.gasCylinderId', 'gasCylinderId')
      .addSelect('SUM(item.quantity)', 'quantity')
      .where('ord.distributorId = :distributorId', { distributorId })
      .andWhere('ord.status IN (:...abiertos)', {
        abiertos: [
          OrderStatus.RESERVED,
          OrderStatus.PENDING,
          OrderStatus.ACCEPTED,
          OrderStatus.ON_THE_WAY,
        ],
      })
      .groupBy('item.gasCylinderId')
      .getRawMany<{ gasCylinderId: string; quantity: string }>();
    return new Map(filas.map((f) => [f.gasCylinderId, Number(f.quantity)]));
  }

  /** Renglones de pedidos entregados desde `desde` (inclusive). */
  async deliveredItemsSince(
    distributorId: string,
    desde: Date,
    manager?: EntityManager,
  ): Promise<
    Array<{
      orderId: string;
      deliveredAt: Date;
      vehicleCarId: string | null;
      gasCylinderId: string;
      quantity: number;
    }>
  > {
    const filas = await (manager ?? this.orderRepository.manager)
      .createQueryBuilder(OrderItem, 'item')
      .innerJoin('item.order', 'ord')
      .select('ord.orderId', 'orderId')
      .addSelect('ord.deliveredAt', 'deliveredAt')
      .addSelect('ord.vehicleCarId', 'vehicleCarId')
      .addSelect('item.gasCylinderId', 'gasCylinderId')
      .addSelect('item.quantity', 'quantity')
      .where('ord.distributorId = :distributorId', { distributorId })
      .andWhere('ord.status = :entregado', {
        entregado: OrderStatus.DELIVERED,
      })
      .andWhere('ord.deliveredAt >= :desde', { desde })
      .orderBy('ord.deliveredAt', 'ASC')
      .addOrderBy('ord.orderId', 'ASC')
      .getRawMany<{
        orderId: string;
        deliveredAt: Date;
        vehicleCarId: string | null;
        gasCylinderId: string;
        quantity: number;
      }>();
    return filas;
  }
}
