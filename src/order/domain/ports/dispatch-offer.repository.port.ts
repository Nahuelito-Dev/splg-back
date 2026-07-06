import { DispatchOffer } from '../../entities/dispatch-offer.entity';

/**
 * PUERTO de persistencia de ofertas de despacho. El orquestador habla con esta
 * interfaz; el adapter TypeORM resuelve el cómo. Aislar la persistencia permite
 * testear la lógica de despacho secuencial con un repo en memoria.
 */
export abstract class DispatchOfferRepositoryPort {
  /** Crea una oferta OFFERED para un chofer, válida hasta `expiresAt`. */
  abstract create(
    orderId: string,
    driverId: string,
    expiresAt: Date,
  ): Promise<DispatchOffer>;

  /** IDs de choferes YA contactados para este pedido (cualquier estado). */
  abstract findOfferedDriverIds(orderId: string): Promise<string[]>;

  /** True si el pedido tiene una oferta OFFERED vigente (no vencida ni cerrada). */
  abstract hasActiveOffer(orderId: string): Promise<boolean>;

  /** Ofertas OFFERED cuyo `expiresAt` ya pasó (para el cron de timeout). */
  abstract findExpired(now: Date): Promise<DispatchOffer[]>;

  /** Marca una oferta con un nuevo estado (ACCEPTED/REJECTED/EXPIRED). */
  abstract updateStatus(
    offerId: string,
    status: DispatchOffer['status'],
  ): Promise<void>;

  /**
   * Cierra la oferta OFFERED activa de un pedido con el estado dado. Devuelve
   * true si había una activa. Se usa cuando el chofer acepta/rechaza.
   */
  abstract closeActiveOffer(
    orderId: string,
    driverId: string,
    status: DispatchOffer['status'],
  ): Promise<boolean>;
}
