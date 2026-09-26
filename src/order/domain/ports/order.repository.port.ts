import { Order } from '../../entities/order.entity';

/** Resultado paginado uniforme de las consultas de pedidos. */
export interface PaginatedOrders {
  orders: Order[];
  total: number;
  limit: number;
  offset: number;
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

  /** Guarda (crea o actualiza) un pedido ya materializado. */
  abstract save(order: Order): Promise<Order>;
}
