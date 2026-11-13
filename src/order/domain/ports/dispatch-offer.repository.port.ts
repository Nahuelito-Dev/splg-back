import { EntityManager } from 'typeorm';
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
   * True si el pedido es parada de un lote de recorrido vivo (M4, CU-107): se
   * está ofreciendo completo a un chofer y no se ofrece suelto a la vez.
   */
  abstract isInLiveBatch(orderId: string): Promise<boolean>;

  /**
   * True si el pedido es parada activa de una hoja de ruta (F34) en borrador o
   * confirmada: lo planifica el admin y lo asigna el chofer al iniciar la hoja,
   * así que el despacho automático (ofertas) no lo ofrece suelto, el chofer no
   * lo acepta y el admin no lo asigna por fuera de la hoja. Con `manager`, lee
   * dentro de la transacción de quien llama (con el pedido bloqueado).
   */
  abstract isInPlannedRouteSheet(
    orderId: string,
    manager?: EntityManager,
  ): Promise<boolean>;

  /**
   * True si el pedido es programado, la agrupación por recorrido (M4) está
   * encendida en su distribuidora y todavía falta más de `batchingHoldMinutes`
   * para que empiece su franja: hasta entonces es candidato de M4 y M1 no lo
   * ofrece suelto. Con M4 apagado, y para un pedido inmediato, siempre falso.
   */
  abstract isHeldForBatching(orderId: string): Promise<boolean>;

  /**
   * ¿`driverId` (user_id) TUVO este pedido alguna vez (aceptó la oferta o se le
   * asignó a mano)? Es la constancia de `recordDriverHeldOrder`.
   */
  abstract hasHeldOrder(orderId: string, driverId: string): Promise<boolean>;

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

  /**
   * Cierra una oferta que sigue OFFERED con un nuevo estado (ACCEPTED/REJECTED/
   * EXPIRED/SUPERSEDED). Devuelve `false` si la oferta ya no estaba OFFERED (otro
   * camino la cerró antes): en ese caso no se toca, para no pisar una aceptada.
   */
  abstract updateStatus(
    offerId: string,
    status: DispatchOffer['status'],
  ): Promise<boolean>;

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
   * Retira las ofertas OFFERED activas de un pedido que ya se resolvió por otra
   * vía (el admin lo asignó a mano, o un chofer lo tomó del pool), salvo la de
   * `exceptDriverId` (el que se queda con el pedido: su constancia la deja
   * `recordDriverHeldOrder`). Escribe con el `manager` de la transacción que
   * asigna el pedido, así la asignación y el retiro son atómicos y no hay otra
   * conexión esperando el lock de la fila del pedido. Devuelve los `driverId`
   * (user_id) de los choferes a quienes se les retiró, para avisarles.
   */
  abstract withdrawOtherActiveOffers(
    manager: EntityManager,
    orderId: string,
    exceptDriverId: string | null,
    status: DispatchOffer['status'],
  ): Promise<string[]>;
}
