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

  /** Lanza 400 con un mensaje claro si el chofer (`delivery_id`) no puede aceptar. */
  abstract assertPuedeAceptar(
    distributorId: string,
    deliveryId: string,
  ): Promise<void>;

  /** Lo mismo para la asignación manual del administrador. */
  abstract assertPuedeAsignar(
    distributorId: string,
    deliveryId: string,
  ): Promise<void>;
}
