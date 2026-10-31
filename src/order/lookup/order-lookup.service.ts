import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { InjectRepository } from '@nestjs/typeorm';
import {
  EntityManager,
  FindOptionsWhere,
  In,
  MoreThanOrEqual,
  Not,
  Repository,
} from 'typeorm';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';

/** Lo mínimo de un pedido que necesitan los módulos que no son `order`. */
export interface OrderRef {
  orderId: string;
  customerId: string;
}

/** El pedido visto desde `cylinder` para cargarle envases: estado y chofer. */
export interface OrderDespachoRef extends OrderRef {
  status: OrderStatus;
  deliveryId: string | null;
}

/** Estado de un pedido visto desde `payments`: si todavía se puede cobrar. */
export interface OrderPaymentState {
  status: OrderStatus;
  paymentStatus: PaymentStatus;
}

/** El pedido visto desde `payments` para devolver un pago (CU-168). */
export interface OrderRefundRef {
  orderId: string;
  customerId: string;
  distributorId: string;
  status: OrderStatus;
  expressSurchargeAmount: number;
  expressDegradedAt: Date | null;
}

/** Una compra entregada de un cliente, con lo que llevaba: la base de la estimación de recompra. */
export interface CompraEntregadaRef {
  orderId: string;
  customerId: string;
  deliveredAt: Date;
  addressId: string;
  timeSlotId: string | null;
  paymentMethod: PaymentMethod;
  items: Array<{ gasCylinderId: string; quantity: number; weightKg: number }>;
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

  /**
   * Lo que `cylinder` necesita para cargarle envases a un pedido: estado y
   * chofer asignado. Dentro de la distribuidora (lo ajeno es null). Con
   * `manager` lee dentro de esa transacción y deja la fila bloqueada
   * (`FOR SHARE`): una entrega, cancelación o reasignación concurrente
   * (`FOR UPDATE`) espera a que termine la carga, así lo validado sigue
   * valiendo hasta el commit.
   */
  async findParaDespacho(
    orderId: string,
    distributorId: string,
    manager?: EntityManager,
  ): Promise<OrderDespachoRef | null> {
    const repo = manager ? manager.getRepository(Order) : this.orderRepository;
    const order = await repo.findOne({
      where: { orderId, distributorId },
      select: {
        orderId: true,
        customerId: true,
        status: true,
        deliveryId: true,
      },
      ...(manager ? { lock: { mode: 'pessimistic_read' as const } } : {}),
    });
    return order
      ? {
          orderId: order.orderId,
          customerId: order.customerId,
          status: order.status,
          deliveryId: order.deliveryId,
        }
      : null;
  }

  /**
   * Lo que `payments` necesita para devolver un pago: dentro de la distribuidora
   * (lo ajeno es null, como si no existiera) o, sin distribuidora, por id.
   */
  async findForRefund(
    orderId: string,
    distributorId?: string | null,
  ): Promise<OrderRefundRef | null> {
    const where: FindOptionsWhere<Order> = { orderId };
    if (distributorId) where.distributorId = distributorId;
    const order = await this.orderRepository.findOne({
      where,
      select: {
        orderId: true,
        customerId: true,
        distributorId: true,
        status: true,
        expressSurchargeAmount: true,
        expressDegradedAt: true,
      },
    });
    return order
      ? {
          orderId: order.orderId,
          customerId: order.customerId,
          distributorId: order.distributorId,
          status: order.status,
          expressSurchargeAmount: order.expressSurchargeAmount,
          expressDegradedAt: order.expressDegradedAt,
        }
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

  /**
   * Pedidos que un chofer entregó con un vehículo desde `desde` (inclusive) y,
   * si se pasa, hasta `hasta` (inclusive): lo que se muestra en la rendición del
   * camión, con cómo se cobró cada uno.
   */
  async entregadosPorVehiculo(args: {
    distributorId: string;
    deliveryId: string;
    carId: string;
    desde: Date;
    hasta?: Date | null;
  }): Promise<
    Array<{
      orderId: string;
      totalAmount: number;
      paymentMethod: PaymentMethod;
      paymentStatus: PaymentStatus;
      deliveredAt: Date;
    }>
  > {
    const consulta = this.orderRepository
      .createQueryBuilder('ord')
      .select('ord.orderId', 'orderId')
      .addSelect('ord.totalAmount', 'totalAmount')
      .addSelect('ord.paymentMethod', 'paymentMethod')
      .addSelect('ord.paymentStatus', 'paymentStatus')
      .addSelect('ord.deliveredAt', 'deliveredAt')
      .where('ord.distributorId = :distributorId', {
        distributorId: args.distributorId,
      })
      .andWhere('ord.deliveryId = :deliveryId', {
        deliveryId: args.deliveryId,
      })
      .andWhere('ord.vehicleCarId = :carId', { carId: args.carId })
      .andWhere('ord.status = :entregado', { entregado: OrderStatus.DELIVERED })
      .andWhere('ord.deliveredAt >= :desde', { desde: args.desde });
    if (args.hasta) {
      consulta.andWhere('ord.deliveredAt <= :hasta', { hasta: args.hasta });
    }
    const filas = await consulta
      .orderBy('ord.deliveredAt', 'ASC')
      .addOrderBy('ord.orderId', 'ASC')
      .getRawMany<{
        orderId: string;
        totalAmount: string;
        paymentMethod: PaymentMethod;
        paymentStatus: PaymentStatus;
        deliveredAt: Date;
      }>();
    return filas.map((f) => ({ ...f, totalAmount: Number(f.totalAmount) }));
  }

  /** Pedidos aceptados o en camino de un chofer: lo que tiene en curso. */
  countEnCurso(deliveryId: string, manager?: EntityManager): Promise<number> {
    return (manager ?? this.orderRepository.manager)
      .getRepository(Order)
      .count({
        where: {
          deliveryId,
          status: In([OrderStatus.ACCEPTED, OrderStatus.ON_THE_WAY]),
        },
      });
  }

  /**
   * La última compra entregada del cliente, de cualquier distribuidora (el
   * cliente es uno solo para todas): cuándo se entregó y cuántos kilos de gas
   * llevaba. `null` si nunca recibió un pedido. Para estimar la recompra.
   */
  async ultimaCompraEntregada(
    customerId: string,
  ): Promise<{ deliveredAt: Date; kg: number } | null> {
    const manager = this.orderRepository.manager;
    const pedido = await manager.getRepository(Order).findOne({
      where: { customerId, status: OrderStatus.DELIVERED },
      order: { deliveredAt: { direction: 'DESC', nulls: 'LAST' } },
      select: { orderId: true, deliveredAt: true },
    });
    if (!pedido?.deliveredAt) return null;
    const renglones = await manager.getRepository(OrderItem).find({
      where: { orderId: pedido.orderId },
      relations: { gasCylinder: true },
    });
    const kg = renglones
      .reduce(
        (suma, r) =>
          suma.plus(new Decimal(r.gasCylinder.weight).times(r.quantity)),
        new Decimal(0),
      )
      .toNumber();
    return { deliveredAt: pedido.deliveredAt, kg };
  }
  /**
   * Los pedidos entregados por la distribuidora desde `desde` (inclusive), con
   * sus renglones y el peso de cada garrafa, del más viejo al más nuevo. Con
   * `customerId` sólo los de ese cliente. Para estimar cuándo se le acaba el gas.
   */
  async comprasEntregadas(
    distributorId: string,
    desde: Date,
    customerId?: string,
  ): Promise<CompraEntregadaRef[]> {
    const consulta = this.orderRepository.manager
      .createQueryBuilder(OrderItem, 'item')
      .innerJoin('item.order', 'ord')
      .innerJoin('item.gasCylinder', 'gc')
      .select('ord.orderId', 'orderId')
      .addSelect('ord.customerId', 'customerId')
      .addSelect('ord.deliveredAt', 'deliveredAt')
      .addSelect('ord.addressId', 'addressId')
      .addSelect('ord.timeSlotId', 'timeSlotId')
      .addSelect('ord.paymentMethod', 'paymentMethod')
      .addSelect('item.gasCylinderId', 'gasCylinderId')
      .addSelect('item.quantity', 'quantity')
      .addSelect('gc.weight', 'weight')
      .where('ord.distributorId = :distributorId', { distributorId })
      .andWhere('ord.status = :entregado', { entregado: OrderStatus.DELIVERED })
      .andWhere('ord.deliveredAt >= :desde', { desde });
    if (customerId)
      consulta.andWhere('ord.customerId = :customerId', { customerId });
    const filas = await consulta
      .orderBy('ord.deliveredAt', 'ASC')
      .addOrderBy('ord.orderId', 'ASC')
      .getRawMany<{
        orderId: string;
        customerId: string;
        deliveredAt: Date;
        addressId: string;
        timeSlotId: string | null;
        paymentMethod: PaymentMethod;
        gasCylinderId: string;
        quantity: number;
        weight: string;
      }>();
    const porPedido = new Map<string, CompraEntregadaRef>();
    for (const f of filas) {
      let compra = porPedido.get(f.orderId);
      if (!compra) {
        compra = {
          orderId: f.orderId,
          customerId: f.customerId,
          deliveredAt: f.deliveredAt,
          addressId: f.addressId,
          timeSlotId: f.timeSlotId,
          paymentMethod: f.paymentMethod,
          items: [],
        };
        porPedido.set(f.orderId, compra);
      }
      compra.items.push({
        gasCylinderId: f.gasCylinderId,
        quantity: Number(f.quantity),
        weightKg: Number(f.weight),
      });
    }
    return [...porPedido.values()];
  }

  /**
   * Los clientes de la distribuidora con un pedido abierto (reservado,
   * pendiente, aceptado o en camino) o hecho desde `creadoDesde` sin cancelar:
   * a ellos no se les ofrece reponer.
   */
  async clientesConPedidoVigente(
    distributorId: string,
    creadoDesde: Date,
  ): Promise<Set<string>> {
    const filas = await this.orderRepository
      .createQueryBuilder('ord')
      .select('DISTINCT ord.customerId', 'customerId')
      .where('ord.distributorId = :distributorId', { distributorId })
      .andWhere(
        '(ord.status IN (:...abiertos) OR (ord.status != :cancelado AND ord.createdAt >= :creadoDesde))',
        {
          abiertos: [
            OrderStatus.RESERVED,
            OrderStatus.PENDING,
            OrderStatus.ACCEPTED,
            OrderStatus.ON_THE_WAY,
          ],
          cancelado: OrderStatus.CANCELLED,
          creadoDesde,
        },
      )
      .getRawMany<{ customerId: string }>();
    return new Set(filas.map((f) => f.customerId));
  }

  /**
   * ¿El cliente hizo algún pedido en la distribuidora desde `desde` sin
   * cancelarlo? Para cerrar una invitación a la que se le adelantó.
   */
  async hayPedidoDesde(
    distributorId: string,
    customerId: string,
    desde: Date,
  ): Promise<boolean> {
    return this.orderRepository.exists({
      where: {
        distributorId,
        customerId,
        status: Not(OrderStatus.CANCELLED),
        createdAt: MoreThanOrEqual(desde),
      },
    });
  }
}
