import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThanOrEqual, Repository } from 'typeorm';
import {
  inicioDelDiaArgentino,
  rangoDelDiaArgentino,
} from '../../common/utils/dias-argentina';
import {
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../entities/order.entity';
import {
  OrderListFilters,
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

  findById(id: string): Promise<Order | null> {
    return this.orderRepository.findOne({ where: { orderId: id } });
  }

  findByIdFull(id: string): Promise<Order | null> {
    return this.orderRepository.findOne({
      where: { orderId: id },
      // Historial: el chofer, el cliente o la dirección dados de baja siguen
      // apareciendo en lo que ya pasó (H-74).
      withDeleted: true,
      relations: FULL_RELATIONS,
    });
  }

  /** Agrega `distributor_id` al where sólo si se pasó un tenant (scope opcional). */
  private scoped<T extends Record<string, unknown>>(
    where: T,
    distributorId?: string | null,
  ): T {
    return distributorId ? { ...where, distributorId } : where;
  }

  async findAllPaginated(
    limit: number,
    offset: number,
    distributorId?: string | null,
    filters?: OrderListFilters,
  ): Promise<PaginatedOrders> {
    // Sin filtros de búsqueda: se mantiene la consulta simple de siempre.
    if (
      !filters?.term &&
      !filters?.status &&
      !filters?.paymentStatus &&
      !filters?.from &&
      !filters?.to
    ) {
      const [orders, total] = await this.orderRepository.findAndCount({
        where: this.scoped({}, distributorId),
        take: limit,
        skip: offset,
        withDeleted: true,
        relations: FULL_RELATIONS,
        order: { createdAt: 'DESC', orderId: 'DESC' },
      });
      return { orders, total, limit, offset };
    }

    // El filtro se resuelve en una query aparte, SIN los joins a relaciones
    // *-to-many (`items`): TypeORM pagina mal (`take`/`skip`) cuando la fila se
    // multiplica por un join uno-a-muchos. Acá sólo se junta `customer`
    // (many-to-one, no duplica filas) para poder buscar por sus datos.
    const filtro = this.orderRepository
      .createQueryBuilder('order')
      .leftJoin('order.customer', 'customer')
      .withDeleted();

    if (distributorId) {
      filtro.andWhere('order.distributorId = :distributorId', {
        distributorId,
      });
    }
    if (filters.status) {
      filtro.andWhere('order.status = :status', { status: filters.status });
    }
    if (filters.paymentStatus) {
      filtro.andWhere('order.paymentStatus = :paymentStatus', {
        paymentStatus: filters.paymentStatus,
      });
    }
    // Días en hora argentina, `to` inclusivo (misma regla que /reports).
    const desde = filters.from ? inicioDelDiaArgentino(filters.from) : null;
    if (desde) {
      filtro.andWhere('order.createdAt >= :from', { from: desde });
    }
    const hasta = filters.to ? rangoDelDiaArgentino(filters.to) : null;
    if (hasta) {
      filtro.andWhere('order.createdAt < :to', { to: hasta.hasta });
    }
    const termino = filters.term?.trim();
    if (termino) {
      filtro.andWhere(
        '(customer.fullName ILIKE :term OR customer.email ILIKE :term ' +
          'OR customer.phoneNumber ILIKE :term ' +
          'OR CAST(order.orderId AS text) ILIKE :idTerm)',
        { term: `%${termino}%`, idTerm: `%${termino}%` },
      );
    }

    const total = await filtro.getCount();
    if (total === 0) return { orders: [], total, limit, offset };

    const { entities: pagina } = await filtro
      .clone()
      .orderBy('order.createdAt', 'DESC')
      .addOrderBy('order.orderId', 'DESC')
      .take(limit)
      .skip(offset)
      .getRawAndEntities();
    const ids = pagina.map((order) => order.orderId);
    if (ids.length === 0) return { orders: [], total, limit, offset };

    // Con los ids de la página ya resueltos, se trae el pedido completo (con
    // `items` y el resto de las relaciones) por la vía segura de siempre.
    const orders = await this.orderRepository.find({
      where: { orderId: In(ids) },
      withDeleted: true,
      relations: FULL_RELATIONS,
      order: { createdAt: 'DESC', orderId: 'DESC' },
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
        { status: OrderStatus.PENDING, deliveryId: IsNull() },
        distributorId,
      ),
      take: limit,
      skip: offset,
      withDeleted: true,
      relations: [
        'customer',
        'customer.customer',
        'items',
        'items.gasCylinder',
        'address',
        'timeSlot',
      ],
      order: { createdAt: 'ASC', orderId: 'ASC' },
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
      where: this.scoped({ customerId }, distributorId),
      take: limit,
      skip: offset,
      withDeleted: true,
      relations: [
        'customer',
        'customer.customer',
        'delivery',
        'delivery.user',
        'items',
        'items.gasCylinder',
        'address',
        'timeSlot',
      ],
      order: { createdAt: 'DESC', orderId: 'DESC' },
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
      where: this.scoped({ deliveryId }, distributorId),
      take: limit,
      skip: offset,
      withDeleted: true,
      relations: [
        'customer',
        'customer.customer',
        'items',
        'items.gasCylinder',
        'address',
        'timeSlot',
      ],
      order: { createdAt: 'DESC', orderId: 'DESC' },
    });
    return { orders, total, limit, offset };
  }

  async findCurrentOfDelivery(
    deliveryId: string,
    distributorId: string,
    desde: Date,
  ): Promise<Order | null> {
    const activos = await this.orderRepository.find({
      where: {
        deliveryId,
        distributorId,
        status: In([OrderStatus.ON_THE_WAY, OrderStatus.ACCEPTED]),
      },
      relations: FULL_RELATIONS,
      order: { acceptedAt: 'ASC', orderId: 'ASC' },
    });
    const enCamino = activos.find((o) => o.status === OrderStatus.ON_THE_WAY);
    if (enCamino ?? activos[0]) return enCamino ?? activos[0];
    return this.orderRepository.findOne({
      where: {
        deliveryId,
        distributorId,
        status: OrderStatus.DELIVERED,
        paymentMethod: PaymentMethod.CASH,
        paymentStatus: PaymentStatus.PENDING,
        deliveredAt: MoreThanOrEqual(desde),
      },
      relations: FULL_RELATIONS,
      order: { deliveredAt: 'DESC', orderId: 'DESC' },
    });
  }

  save(order: Order): Promise<Order> {
    return this.orderRepository.save(order);
  }
}
