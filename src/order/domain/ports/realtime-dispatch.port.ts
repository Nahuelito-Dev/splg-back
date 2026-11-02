/**
 * PUERTO de despacho en tiempo real. El dominio/casos de uso dependen de ESTA
 * interfaz, no de Socket.io ni Redis: "buscá choferes cercanos" / "avisá al
 * chofer" / "avisá al cliente" se expresan acá, y un adapter de infraestructura
 * (Redis GEO + gateways Socket.io) implementa el cómo.
 *
 * Se declara como clase abstracta porque en NestJS es el token de inyección
 * idiomático para puertos (las interfaces no existen en runtime). Ver
 * RealtimeDispatchAdapter (infrastructure) para la implementación concreta.
 */
export abstract class RealtimeDispatchPort {
  /** IDs de choferes dentro de `radiusKm` de la coordenada (Redis GEO). */
  abstract findNearbyDrivers(
    lat: number,
    lng: number,
    radiusKm: number,
  ): Promise<string[]>;

  /**
   * Posición actual de un chofer en el radar (Redis GEO), la misma que reporta
   * por socket. Es la vía HTTP para cuando el socket no está conectado.
   */
  abstract reportDriverLocation(
    driverUserId: string,
    lat: number,
    lng: number,
  ): Promise<void>;

  /**
   * Última posición conocida del chofer (el radar) con el momento en que se
   * registró. Sólo si `orderId` es el pedido que el chofer está entregando
   * ahora (su pedido activo): la posición del radar es global, y no se le
   * muestra a un cliente cuyo pedido no es el que el chofer lleva. `null` si no
   * es su pedido activo o no está en el radar.
   */
  abstract lastDriverLocation(
    driverUserId: string,
    orderId: string,
  ): Promise<{ lat: number; lng: number; at: string | null } | null>;

  /** Oferta de un pedido nuevo a un chofer (WebSocket). */
  abstract notifyDriverNewOrder(driverId: string, payload: unknown): void;

  /** Aviso de cancelación a un chofer (WebSocket). */
  abstract notifyDriverOrderCancelled(driverId: string, payload: unknown): void;

  /**
   * Aviso al chofer asignado de que el cliente cambió la dirección de entrega
   * (WebSocket, evento `order:address-changed`). `driverUserId` es el id de
   * usuario del chofer, no el de su perfil de reparto.
   */
  abstract notifyDriverOrderAddressChanged(
    driverUserId: string,
    payload: unknown,
  ): void;

  /**
   * Aviso al chofer asignado de un código de entrega que el cliente erró
   * (`order:delivery-code-failed`) o que quedó bloqueado
   * (`order:delivery-code-blocked`). `driverUserId` es el id de usuario.
   */
  abstract notifyDriverDeliveryCode(
    driverUserId: string,
    event: 'order:delivery-code-failed' | 'order:delivery-code-blocked',
    payload: unknown,
  ): void;

  /** Evento arbitrario al cliente (WebSocket): estado de su pedido, etc. */
  abstract notifyCustomer(
    customerId: string,
    event: string,
    payload: unknown,
  ): void;

  /**
   * Evento del ciclo de vida del pedido a los admins DE ESA distribuidora
   * (panel en vivo) más los super admin, que ven todas. Sin `distributorId`
   * (eventos que no son de un tenant en particular) sólo llega a los super
   * admin.
   */
  abstract notifyAdmins(
    event: string,
    payload: unknown,
    distributorId?: string | null,
  ): void;

  /**
   * Marca que un chofer está entregando un pedido: su GPS se reenviará a este
   * cliente para tracking en vivo (se activa al pasar a ON_THE_WAY).
   * `distributorId` viaja con el tracking para que el aviso de posición al
   * panel (`order:driver-location`) llegue sólo a los admins de esa
   * distribuidora (ver `DriversGateway.handleDriverLocation`).
   */
  abstract startTracking(
    driverUserId: string,
    orderId: string,
    customerId: string,
    distributorId?: string | null,
  ): void;

  /** Deja de reenviar el GPS del chofer (al entregar o cancelar). */
  abstract stopTracking(driverUserId: string): void;
}
