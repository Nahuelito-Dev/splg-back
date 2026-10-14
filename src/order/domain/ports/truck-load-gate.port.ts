import type { EntityManager } from 'typeorm';

/**
 * PUERTO del control de carga del camión visto desde el despacho (decisión
 * D5 y revisión de la jornada). Un chofer con carga abierta sólo recibe y acepta
 * pedidos con la carga EN RUTA (en carga todavía no salió el stock; devuelta ya
 * declaró la vuelta), y su vehículo en uso tiene que ser el de la carga. Sin
 * carga, sólo se le niega si la distribuidora exige tenerla
 * (`stock_control.requireOpenTruckLoad`, por defecto no).
 *
 * El despacho depende de ESTA interfaz, no del módulo `truck-load`.
 */
export abstract class TruckLoadGatePort {
  /** De esos choferes (`user_id`), los que pueden recibir ofertas. */
  abstract choferesQuePuedenRecibir(
    distributorId: string,
    userIds: string[],
  ): Promise<Set<string>>;

  /**
   * Por qué el chofer (`user_id`) no puede recibir pedidos, con el texto para
   * mostrarle en la app ("Abrí tu carga para recibir pedidos"); `null` si puede.
   */
  abstract motivoParaNoRecibir(
    distributorId: string,
    userId: string,
  ): Promise<string | null>;

  /**
   * Lanza 400 con un mensaje claro si el chofer (`delivery_id`) no puede aceptar.
   *
   * Con `manager` (la transacción de la aceptación) toma `FOR SHARE` sobre la
   * carga abierta del chofer antes de leerla: la vuelta del camión
   * (`return`) la toma `FOR UPDATE`, así que o la aceptación termina antes y la
   * vuelta ve el pedido en curso, o la vuelta termina antes y la aceptación ve
   * la carga devuelta. Sin esto podía quedar un pedido aceptado sobre una
   * carga `returned`.
   */
  abstract assertPuedeAceptar(
    distributorId: string,
    deliveryId: string,
    manager?: EntityManager,
  ): Promise<void>;

  /** Lo mismo, con el mismo lock, para la asignación manual del administrador. */
  abstract assertPuedeAsignar(
    distributorId: string,
    deliveryId: string,
    manager?: EntityManager,
  ): Promise<void>;
}
