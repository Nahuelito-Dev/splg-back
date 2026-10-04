import { DispatchOffer } from '../../entities/dispatch-offer.entity';

/** Ver `DispatchOfferRepositoryPort.findDriverOfferState`. */
export interface DriverOfferState {
  blocked: string[];
  reofferable: string[];
}

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
    distributorId?: string | null,
  ): Promise<DispatchOffer>;

  /**
   * Clasifica a los choferes ya contactados para este pedido:
   *  - `blocked`: no se les vuelve a ofrecer ahora (rechazó, aceptó, tiene una
   *    oferta vigente, su oferta venció hace menos de `cooldownMs` o ya
   *    acumuló `maxReofertas` ofertas vencidas: agotado para este pedido).
   *  - `reofferable`: todas sus ofertas vencieron hace más de `cooldownMs` y
   *    tienen menos de `maxReofertas`; pueden volver a ser candidatos si no
   *    hay choferes nuevos.
   */
  abstract findDriverOfferState(
    orderId: string,
    now: Date,
    cooldownMs: number,
    maxReofertas: number,
  ): Promise<DriverOfferState>;

  /**
   * True si el pedido tiene una oferta OFFERED vigente (no vencida ni cerrada).
   * Con `driverId`, sólo mira la de ESE chofer: una oferta activa de OTRO
   * chofer (p. ej. una carrera del despacho automático) no cuenta como "mi
   * oferta real" para quien pregunta (ver `OrderService.rejectOffer`, que
   * distingue una oferta real del despacho de una asignación manual).
   */
  abstract hasActiveOffer(orderId: string, driverId?: string): Promise<boolean>;

  /**
   * Deja constancia de que `driverId` TUVO el pedido (aceptó por oferta o se
   * le asignó a mano): cierra su oferta OFFERED como ACCEPTED o, si no tenía
   * ninguna, inserta una fila ACCEPTED. Así nunca vuelve a ser candidato de
   * ese pedido, aunque después lo libere. Idempotente.
   */
  abstract recordDriverHeldOrder(
    orderId: string,
    driverId: string,
  ): Promise<void>;

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

  /**
   * Cierra TODAS las ofertas OFFERED activas de un pedido, sin filtrar por
   * chofer. La usa una asignación MANUAL (`OrderService.assignDelivery`): el
   * admin ya resolvió el pedido él solo, así que cualquier oferta automática
   * que hubiera quedado en curso para otro chofer (o para el mismo) queda sin
   * efecto — nadie más tiene que creer que el pedido sigue siendo suyo.
   * Devuelve cuántas ofertas cerró.
   */
  abstract closeAllActiveOffers(
    orderId: string,
    status: DispatchOffer['status'],
  ): Promise<number>;
}
