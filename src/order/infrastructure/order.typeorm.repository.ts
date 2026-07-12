import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Order, OrderStatus } from '../entities/order.entity';
import {
  OrderRepositoryPort,
  PaginatedOrders,
} from '../domain/ports/order.repository.port';

/** Relaciones completas de un pedido (detalle / listados de admin). */
const FULL_RELATIONS = [
  'customer',
  'customer.customer',
  'delivery',
  'delivery.user',
  'items',
  'items.gasCylinder',
  'address',
  'timeSlot',
];

/**
 * Adapter TypeORM del OrderRepositoryPort. Único lugar del dominio de órdenes
 * que conoce el Repository<Order> de TypeORM para lecturas/guardado simple.
 */
@Injectable()
export class OrderTypeormRepository extends OrderRepositoryPort {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
  ) {
    super();
  }

  findByIdFull(id: string): Promise<Order | null> {
    return this.orderRepository.findOne({
      where: { order_id: id },
      relations: FULL_RELATIONS,
    });
  }

  /** Agrega `distributor_id` al where sólo si se pasó un tenant (scope opcional). */
  private scoped<T extends Record<string, unknown>>(
    where: T,
    distributorId?: string | null,
  ): T {
    return distributorId ? { ...where, distributor_id: distributorId } : where;
  }

  async findAllPaginated(
    limit: number,
    offset: number,
    distributorId?: string | null,
  ): Promise<PaginatedOrders> {
    const [orders, total] = await this.orderRepository.findAndCount({
      where: this.scoped({}, distributorId),
      take: limit,
      skip: offset,
      relations: FULL_RELATIONS,
      order: { createdAt: 'DESC' },
    });
    return { orders, total, limit, offset };
  }

  async findAvailable(
    limit: number,
    offset: number,
    distributorId?: string | null,
  ): Promise<PaginatedOrders> {
    const [orders, total] = await this.orderRepository.findAndCount({
      where: this.scoped(
        { status: OrderStatus.PENDING, delivery_id: IsNull() },
        distributorId,
      ),
      take: limit,
      skip: offset,
      relations: [
        'customer',
        'customer.customer',
        'items',
        'items.gasCylinder',
        'address',
        'timeSlot',
      ],
      order: { createdAt: 'ASC' },
    });
    return { orders, total, limit, offset };
  }

  async findByCustomer(
    customerId: string,
    limit: number,
    offset: number,
    distributorId?: string | null,
  ): Promise<PaginatedOrders> {
    const [orders, total] = await this.orderRepository.findAndCount({
      where: this.scoped({ customer_id: customerId }, distributorId),
      take: limit,
      skip: offset,
      relations: [
        'delivery',
        'delivery.user',
        'items',
        'items.gasCylinder',
        'address',
        'timeSlot',
      ],
      order: { createdAt: 'DESC' },
    });
    return { orders, total, limit, offset };
  }

  async findByDelivery(
    deliveryId: string,
    limit: number,
    offset: number,
    distributorId?: string | null,
  ): Promise<PaginatedOrders> {
    const [orders, total] = await this.orderRepository.findAndCount({
      where: this.scoped({ delivery_id: deliveryId }, distributorId),
      take: limit,
      skip: offset,
      relations: [
        'customer',
        'customer.customer',
        'items',
        'items.gasCylinder',
        'address',
        'timeSlot',
      ],
      order: { createdAt: 'DESC' },
    });
    return { orders, total, limit, offset };
  }

  save(order: Order): Promise<Order> {
    return this.orderRepository.save(order);
  }
}
