import { Order, OrderStatus, PaymentStatus } from '../../entities/order.entity';

/** Resultado paginado uniforme de las consultas de pedidos. */
export interface PaginatedOrders {
  orders: Order[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Filtros de `GET /orders` para el panel. `term` busca por nombre, email o
 * teléfono del cliente, y por los últimos caracteres del id del pedido.
 * `from`/`to` son fechas locales (YYYY-MM-DD), `to` inclusivo.
 */
export interface OrderListFilters {
  term?: string;
  status?: OrderStatus;
  paymentStatus?: PaymentStatus;
  from?: string;
  to?: string;
}

/**
 * PUERTO de persistencia de pedidos. El dominio/casos de uso hablan con esta
 * interfaz; el adapter TypeORM (infraestructura) resuelve el cómo. Permite
 * testear la lógica con un repo en memoria y aislar TypeORM del núcleo.
 *
 * NOTA: las operaciones transaccionales multi-entidad (crear pedido = reservar
 * stock + persistir en una sola transacción con lock pesimista) NO viven acá;
 * las maneja el use-case con su propia unidad de trabajo, porque cruzan varios
 * agregados. Este puerto cubre lecturas y guardado simple de un pedido.
 */
export abstract class OrderRepositoryPort {
  /** Pedido por id, sin relaciones. */
  abstract findById(id: string): Promise<Order | null>;

  /** Pedido por id con TODAS las relaciones (customer, delivery, items, etc.). */
  abstract findByIdFull(id: string): Promise<Order | null>;

  abstract findAllPaginated(
    limit: number,
    offset: number,
    distributorId?: string | null,
    filters?: OrderListFilters,
  ): Promise<PaginatedOrders>;

  /**
   * Pedidos PENDING sin chofer asignado (para la app del repartidor).
   * Con `distributorId` se restringe al pool de esa distribuidora: un chofer
   * NO debe ver pedidos disponibles de otro tenant.
   */
  abstract findAvailable(
    limit: number,
    offset: number,
    distributorId?: string | null,
  ): Promise<PaginatedOrders>;

  abstract findByCustomer(
    customerId: string,
    limit: number,
    offset: number,
    distributorId?: string | null,
  ): Promise<PaginatedOrders>;

  abstract findByDelivery(
    deliveryId: string,
    limit: number,
    offset: number,
    distributorId?: string | null,
  ): Promise<PaginatedOrders>;

  /**
   * El pedido en curso de un chofer, con todas sus relaciones: el que lleva en
   * camino o, si no, el aceptado más antiguo; y si no tiene ninguno, el
   * entregado en efectivo desde `desde` cuyo cobro sigue pendiente. `null` si
   * no tiene nada de eso. Sin límite de antigüedad para los activos.
   */
  abstract findCurrentOfDelivery(
    deliveryId: string,
    distributorId: string,
    desde: Date,
  ): Promise<Order | null>;

  /** Guarda (crea o actualiza) un pedido ya materializado. */
  abstract save(order: Order): Promise<Order>;
}
