import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AuditoriaDeDatos } from '../../audit/data/auditoria-de-datos';
import { AuditActionTypeId } from '../../audit/entities/audit-action-type.entity';
import { In, IsNull, MoreThanOrEqual, Not, Raw, Repository } from 'typeorm';
import { coordenadasDePunto } from '../../common/geo/punto';
import {
  sqlPedidoEnHojaDeRuta,
  sqlPedidoEnLoteVivo,
  sqlPedidoRetenidoPorAgrupacion,
} from './lote-de-recorrido.sql';
import {
  inicioDelDiaArgentino,
  rangoDelDiaArgentino,
} from '../../common/utils/dias-argentina';
import {
  Order,
  OrderDeliveryMode,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../entities/order.entity';
import {
  OrderListFilters,
  OrderRepositoryPort,
  PaginatedOrders,
  PedidoEnCursoPorChofer,
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

  findOnTheWayByCustomer(
    customerId: string,
    distributorId: string,
  ): Promise<Pick<Order, 'orderId' | 'deliveryCode'>[]> {
    return this.orderRepository.find({
      where: { customerId, distributorId, status: OrderStatus.ON_THE_WAY },
      select: { orderId: true, deliveryCode: true },
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
      !filters?.to &&
      !filters?.deliveredFrom &&
      !filters?.deliveredTo &&
      !filters?.sort &&
      !filters?.order
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
    const entregadoDesde = filters.deliveredFrom
      ? inicioDelDiaArgentino(filters.deliveredFrom)
      : null;
    if (entregadoDesde) {
      filtro.andWhere('order.deliveredAt >= :deliveredFrom', {
        deliveredFrom: entregadoDesde,
      });
    }
    const entregadoHasta = filters.deliveredTo
      ? rangoDelDiaArgentino(filters.deliveredTo)
      : null;
    if (entregadoHasta) {
      filtro.andWhere('order.deliveredAt < :deliveredTo', {
        deliveredTo: entregadoHasta.hasta,
      });
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

    const campo = filters.sort ?? 'createdAt';
    const sentido = filters.order === 'asc' ? 'ASC' : 'DESC';
    const { entities: pagina } = await filtro
      .clone()
      .orderBy(`order.${campo}`, sentido, 'NULLS LAST')
      .addOrderBy('order.orderId', sentido)
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
    });
    // `find` no conserva el orden de los ids: se reordena como lo resolvió la página.
    const posicion = new Map(ids.map((id, i) => [id, i]));
    orders.sort(
      (a, b) => (posicion.get(a.orderId) ?? 0) - (posicion.get(b.orderId) ?? 0),
    );
    return { orders, total, limit, offset };
  }

  async findDistributorsWithAvailable(): Promise<string[]> {
    const filas = await this.orderRepository.find({
      where: {
        status: OrderStatus.PENDING,
        deliveryId: IsNull(),
        orderId: Raw(
          (pedido) =>
            `NOT ${sqlPedidoEnLoteVivo(pedido)} AND NOT ${sqlPedidoRetenidoPorAgrupacion(pedido)} AND NOT ${sqlPedidoEnHojaDeRuta(pedido)}`,
        ),
      },
      select: { orderId: true, distributorId: true },
      withDeleted: true,
    });
    return [...new Set(filas.map((o) => o.distributorId))];
  }

  async findAvailable(
    limit: number,
    offset: number,
    distributorId?: string | null,
    incluirExpress = false,
  ): Promise<PaginatedOrders> {
    const base = {
      status: OrderStatus.PENDING,
      deliveryId: IsNull(),
      ...(incluirExpress ? {} : { deliveryMode: OrderDeliveryMode.STANDARD }),
      // Ni los de un lote de recorrido vivo, ni los que M4 retiene hasta su
      // margen, ni las paradas de una hoja de ruta en borrador o confirmada (F34):
      // se excluyen en la consulta para que no llenen la página (el
      // barrido de M1 toma de a 50) ni el pool los deje tomar sueltos.
      orderId: Raw(
        (pedido) =>
          `NOT ${sqlPedidoEnLoteVivo(pedido)} AND NOT ${sqlPedidoRetenidoPorAgrupacion(pedido)} AND NOT ${sqlPedidoEnHojaDeRuta(pedido)}`,
      ),
      // Ni los que Mercado Pago retuvo por una alerta de fraude.
      paymentFraudHold: false,
    };
    // Sin los de Mercado Pago que esperan el pago (`esperaPagoOnline`): no
    // es Mercado Pago, o ya está pago, o es una reserva con la seña paga.
    const [orders, total] = await this.orderRepository.findAndCount({
      where: [
        { ...base, paymentMethod: Not(PaymentMethod.MERCADOPAGO) },
        { ...base, paymentStatus: PaymentStatus.PAID },
        { ...base, depositPaid: true },
      ].map((w) => this.scoped(w, distributorId)),
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

  async findInProgressOfDeliveries(
    deliveryIds: string[],
  ): Promise<PedidoEnCursoPorChofer[]> {
    if (deliveryIds.length === 0) return [];
    const filas = await this.orderRepository.find({
      where: {
        deliveryId: In(deliveryIds),
        status: In([OrderStatus.ACCEPTED, OrderStatus.ON_THE_WAY]),
      },
      select: {
        orderId: true,
        deliveryId: true,
        status: true,
        deliveryPoint: true,
      },
    });
    return filas.flatMap((o) =>
      o.deliveryId
        ? [
            {
              deliveryId: o.deliveryId,
              orderId: o.orderId,
              status: o.status,
              destino: coordenadasDePunto(o.deliveryPoint),
            },
          ]
        : [],
    );
  }

  async registerWrongDeliveryCode(orderId: string): Promise<number> {
    const res = await this.orderRepository
      .createQueryBuilder()
      .update(Order)
      .set({
        deliveryCodeAttempts: () => '"delivery_code_attempts" + 1',
      })
      .where('order_id = :orderId', { orderId })
      .returning('delivery_code_attempts')
      .execute();
    const fila = (res.raw as Array<{ delivery_code_attempts: number }>)[0];
    return Number(fila?.delivery_code_attempts ?? 0);
  }

  replaceDeliveryCode(
    orderId: string,
    newCode: string,
    generadoPor: 'el chofer' | 'el cliente' | 'un administrador' = 'el chofer',
  ): Promise<boolean> {
    return this.orderRepository.manager.transaction(async (manager) => {
      const [filas]: [Array<{ distributor_id: string }>, number] =
        await manager.query(
          `UPDATE "order"
              SET "deliveryCode" = $2, "delivery_code_attempts" = 0
            WHERE "order_id" = $1 AND "status" = $3
          RETURNING "distributor_id"`,
          [orderId, newCode, OrderStatus.ON_THE_WAY],
        );
      if (filas.length === 0) return false;
      // El código es un secreto y no se audita como columna: queda el hecho.
      await AuditoriaDeDatos.registrar(manager, {
        actionTypeId: AuditActionTypeId.UPDATE,
        entity: Order.name,
        recordId: orderId,
        distributorId: filas[0].distributor_id,
        details: [
          {
            field: 'deliveryCode',
            oldValue: '[código de entrega]',
            newValue: `[código nuevo generado por ${generadoPor}]`,
          },
        ],
      });
      return true;
    });
  }

  upgradeLegacyDeliveryCode(
    orderId: string,
    newCode: string,
  ): Promise<boolean> {
    return this.orderRepository.manager.transaction(async (manager) => {
      const [filas]: [Array<{ distributor_id: string }>, number] =
        await manager.query(
          `UPDATE "order"
              SET "deliveryCode" = $2, "delivery_code_attempts" = 0
            WHERE "order_id" = $1
              AND "status" IN ($3, $4)
              AND "deliveryCode" IS NOT NULL
              AND "deliveryCode" !~ '^[0-9]{6}$'
          RETURNING "distributor_id"`,
          [orderId, newCode, OrderStatus.ACCEPTED, OrderStatus.ON_THE_WAY],
        );
      if (filas.length === 0) return false;
      await AuditoriaDeDatos.registrar(manager, {
        actionTypeId: AuditActionTypeId.UPDATE,
        entity: Order.name,
        recordId: orderId,
        distributorId: filas[0].distributor_id,
        details: [
          {
            field: 'deliveryCode',
            oldValue: '[código de entrega anterior]',
            newValue: '[código de 6 dígitos generado al mostrarlo al cliente]',
          },
        ],
      });
      return true;
    });
  }

  save(order: Order): Promise<Order> {
    return this.orderRepository.save(order);
  }
}
