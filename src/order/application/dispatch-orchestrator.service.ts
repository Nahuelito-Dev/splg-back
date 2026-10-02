import { coordenadasDePunto } from '../../common/geo/punto';
import { Injectable, Logger } from '@nestjs/common';
import { Order, OrderStatus } from '../entities/order.entity';
import { DispatchOfferStatus } from '../entities/dispatch-offer.entity';
import { DeliveryService } from '../../delivery/delivery.service';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import { DispatchOfferRepositoryPort } from '../domain/ports/dispatch-offer.repository.port';
import { NotificationsService } from '../../notifications/notifications.service';
import { FleetDispatchLockService } from '../../fleet/fleet-dispatch-lock.service';

/**
 * Cache del bloqueo de flota DENTRO de un mismo intento de oferta
 * (`findNearestAvailable`): un chofer que reaparece en el radio siguiente
 * (radios progresivos, casi siempre superconjuntos) no se vuelve a consultar.
 * Vive y muere con cada llamada; nunca se comparte entre intentos, porque el
 * estado de la flota puede cambiar entre una oferta y la siguiente.
 */
interface CacheDeInhabilitacion {
  evaluados: Set<string>;
  inhabilitados: Set<string>;
}

/**
 * Orquestador de despacho SECUENCIAL con timeout (SRS): un pedido se ofrece al
 * chofer más cercano disponible; si no responde en `OFFER_TTL_SECONDS`, se
 * ofrece al siguiente más cercano que no haya sido contactado, ampliando el
 * radio de a pasos. Reemplaza el broadcast a todos.
 *
 * El estado de cada oferta es DURABLE (tabla, vía DispatchOfferRepositoryPort):
 * sobrevive reinicios, es multi-instancia y auditable. El vencimiento lo dispara
 * un cron corto que llama a `handleExpiredOffers`.
 */
@Injectable()
export class DispatchOrchestratorService {
  private readonly logger = new Logger(DispatchOrchestratorService.name);

  /** Ventana de aceptación de una oferta antes de pasar al siguiente chofer. */
  static readonly OFFER_TTL_SECONDS = 30;

  /** Radio progresivo (km): del más chico al más grande. */
  private static readonly RADIUS_STEPS_KM = [5, 10, 15, 20];

  constructor(
    private readonly dispatch: RealtimeDispatchPort,
    private readonly orders: OrderRepositoryPort,
    private readonly offers: DispatchOfferRepositoryPort,
    private readonly deliveries: DeliveryService,
    private readonly notifications: NotificationsService,
    // Bloqueo de flota (CU-136 a CU-138): un chofer con la licencia vencida,
    // o cuyo vehículo tenga el seguro/VTV vencido, no recibe ofertas.
    private readonly fleet: FleetDispatchLockService,
  ) {}

  /**
   * Ofrece el pedido al chofer más cercano que aún no haya sido contactado.
   * Best-effort: si no hay candidatos, no hace nada (el cron reintentará cuando
   * aparezcan choferes). Devuelve el driver_id ofrecido, o null si no hubo.
   */
  async offerToNextDriver(order: Order): Promise<string | null> {
    const alreadyOffered = new Set(
      await this.offers.findOfferedDriverIds(order.orderId),
    );

    const destino = coordenadasDePunto(order.deliveryPoint);
    // Sin punto de entrega no hay contra qué medir la cercanía.
    if (!destino) return null;
    const candidate = await this.findNearestAvailable(
      destino.lat,
      destino.lng,
      alreadyOffered,
      order.distributorId,
    );

    if (!candidate) {
      this.logger.debug(
        `Sin choferes nuevos para ${order.orderId} (ya contactados: ${alreadyOffered.size})`,
      );
      return null;
    }

    const expiresAt = new Date(
      Date.now() + DispatchOrchestratorService.OFFER_TTL_SECONDS * 1000,
    );
    await this.offers.create(
      order.orderId,
      candidate,
      expiresAt,
      order.distributorId,
    );

    this.dispatch.notifyDriverNewOrder(candidate, {
      event: 'NEW_ORDER',
      orderId: order.orderId,
      totalAmount: order.totalAmount,
      paymentMethod: order.paymentMethod,
      expiresAt: expiresAt.toISOString(),
      items: order.items,
    });

    // Push FCM complementario: si el chofer tiene la app cerrada/en background,
    // el socket no llega pero el push sí. Best-effort, no bloquea el dispatch.
    void this.notifications.sendOfferPushToDriver(candidate, order.orderId);

    this.logger.log(
      `Pedido ${order.orderId} ofrecido a chofer ${candidate} (vence ${expiresAt.toISOString()})`,
    );
    return candidate;
  }

  /**
   * Vence las ofertas OFFERED expiradas y re-ofrece el pedido al siguiente
   * chofer (si sigue pendiente y sin asignar). Lo llama el cron.
   */
  async handleExpiredOffers(): Promise<void> {
    const expired = await this.offers.findExpired(new Date());

    for (const offer of expired) {
      await this.offers.updateStatus(
        offer.offerId,
        DispatchOfferStatus.EXPIRED,
      );

      // Recargar el pedido: pudo haber sido aceptado/cancelado por otra vía.
      const order = await this.orders.findByIdFull(offer.orderId);
      if (!order || !this.isReofferable(order)) continue;

      this.logger.log(
        `Oferta vencida de ${offer.orderId} (chofer ${offer.driverId}) → siguiente`,
      );
      await this.offerToNextDriver(order);
    }
  }

  /**
   * Ofrece el pedido SOLO si no tiene ya una oferta OFFERED vigente. Lo usa el
   * cron para arrancar pedidos pendientes que quedaron sin oferta (ej: al crearse
   * no había choferes cerca) sin pisar una oferta en curso.
   */
  async ensureOffered(order: Order): Promise<void> {
    if (!this.isReofferable(order)) return;
    if (await this.offers.hasActiveOffer(order.orderId)) return;
    await this.offerToNextDriver(order);
  }

  /** El chofer aceptó: cierra su oferta activa como ACCEPTED. */
  async onDriverAccepted(orderId: string, driverId: string): Promise<void> {
    await this.offers.closeActiveOffer(
      orderId,
      driverId,
      DispatchOfferStatus.ACCEPTED,
    );
  }

  /** El chofer rechazó: cierra su oferta y ofrece al siguiente de inmediato. */
  async onDriverRejected(order: Order, driverId: string): Promise<void> {
    await this.offers.closeActiveOffer(
      order.orderId,
      driverId,
      DispatchOfferStatus.REJECTED,
    );
    if (this.isReofferable(order)) {
      await this.offerToNextDriver(order);
    }
  }

  /**
   * El pedido vuelve a PENDING (el chofer lo liberó, o un admin lo destrabó a
   * mano): cierra, si quedó alguna, la oferta OFFERED de ESE chofer para este
   * pedido. Normalmente es un no-op, porque al aceptar `onDriverAccepted` ya
   * la cerró como ACCEPTED y no queda ninguna OFFERED vigente; esto es una red
   * de seguridad ante una carrera del despacho (p. ej. una oferta nueva que se
   * cruza con la liberación). No re-ofrece: quien libera decide aparte si el
   * pedido vuelve al pool.
   */
  async releaseOffer(orderId: string, driverId: string): Promise<void> {
    await this.offers.closeActiveOffer(
      orderId,
      driverId,
      DispatchOfferStatus.EXPIRED,
    );
  }

  /** Solo se re-ofrece un pedido pendiente y sin chofer asignado. */
  private isReofferable(order: Order): boolean {
    return order.status === OrderStatus.PENDING && !order.deliveryId;
  }

  /**
   * Primer chofer (más cercano) dentro del radio progresivo que no esté ya
   * contactado. `getNearbyDrivers` ya devuelve ordenado por cercanía (ASC).
   * Multi-tenant: si el pedido tiene distribuidora, sólo se consideran choferes
   * de ESA distribuidora (un chofer no recibe ofertas de otro tenant).
   *
   * El bloqueo de flota se calcula UNA VEZ POR INTENTO DE OFERTA (esta
   * llamada), no una vez por radio: `cacheDeFlota` (abajo) se crea acá y se
   * pasa a cada `filterEligible`, que sólo consulta la flota de los
   * candidatos que todavía no evaluó en este intento (los radios grandes
   * son casi siempre superconjuntos de los chicos).
   */
  private async findNearestAvailable(
    lat: number,
    lng: number,
    exclude: Set<string>,
    distributorId?: string | null,
  ): Promise<string | null> {
    const cacheDeFlota: CacheDeInhabilitacion = {
      evaluados: new Set(),
      inhabilitados: new Set(),
    };

    for (const radiusKm of DispatchOrchestratorService.RADIUS_STEPS_KM) {
      const drivers = await this.dispatch.findNearbyDrivers(lat, lng, radiusKm);
      const eligible = await this.filterEligible(
        drivers,
        distributorId,
        cacheDeFlota,
      );
      const next = eligible.find((id) => !exclude.has(id));
      if (next) return next;
    }
    return null;
  }

  /**
   * Restringe una lista de choferes (por cercanía) a los habilitados,
   * validados y SIN bloqueo de flota, y si se pasa, de la distribuidora
   * dada, preservando el orden. `driver_id` de la oferta = `user_id` del
   * chofer = `delivery.user_id`.
   *
   * El radar de Redis (`findNearbyDrivers`) sólo sabe de posición: no filtra
   * por habilitación ni validación. Sin este chequeo contra la base, un
   * chofer deshabilitado que igual quedara en el radar (por ejemplo,
   * conectado por socket sin pasar por el endpoint de disponibilidad) seguiría
   * recibiendo ofertas.
   *
   * CU-136 a CU-138: además, un chofer con la licencia vencida o cuyo
   * vehículo tenga el seguro/VTV vencido se saltea igual que uno
   * deshabilitado, y se pasa al siguiente candidato. Sólo se le pregunta a
   * `choferesInhabilitados` por los candidatos que `cache` todavía no
   * evaluó en este intento de oferta.
   */
  private async filterEligible(
    driverIds: string[],
    distributorId: string | null | undefined,
    cache: CacheDeInhabilitacion,
  ): Promise<string[]> {
    if (driverIds.length === 0) return driverIds;
    const elegibles = await this.deliveries.choferesElegibles(
      driverIds,
      distributorId,
    );
    if (elegibles.length === 0) return elegibles;

    const nuevos = elegibles.filter((id) => !cache.evaluados.has(id));
    if (nuevos.length > 0) {
      const inhabilitadosNuevos = await this.fleet.choferesInhabilitados(
        nuevos,
        distributorId,
      );
      for (const id of nuevos) {
        cache.evaluados.add(id);
        if (inhabilitadosNuevos.has(id)) cache.inhabilitados.add(id);
      }
    }

    if (cache.inhabilitados.size === 0) return elegibles;
    return elegibles.filter((id) => !cache.inhabilitados.has(id));
  }
}
