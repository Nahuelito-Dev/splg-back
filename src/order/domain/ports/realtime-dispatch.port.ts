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

  /** Oferta de un pedido nuevo a un chofer (WebSocket). */
  abstract notifyDriverNewOrder(driverId: string, payload: unknown): void;

  /** Aviso de cancelación a un chofer (WebSocket). */
  abstract notifyDriverOrderCancelled(driverId: string, payload: unknown): void;

  /** Evento arbitrario al cliente (WebSocket): estado de su pedido, etc. */
  abstract notifyCustomer(
    customerId: string,
    event: string,
    payload: unknown,
  ): void;

  /** Evento del ciclo de vida del pedido a TODOS los admins (panel en vivo). */
  abstract notifyAdmins(event: string, payload: unknown): void;

  /**
   * Marca que un chofer está entregando un pedido: su GPS se reenviará a este
   * cliente para tracking en vivo (se activa al pasar a ON_THE_WAY).
   */
  abstract startTracking(
    driverUserId: string,
    orderId: string,
    customerId: string,
  ): void;

  /** Deja de reenviar el GPS del chofer (al entregar o cancelar). */
  abstract stopTracking(driverUserId: string): void;
}
