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
import { RedisService } from '../../redis/redis.service';

/** Por qué un pedido pendiente se quedó sin candidatos (payload de `order:no-drivers`). */
export type MotivoSinChoferes =
  | 'no_drivers_in_range'
  | 'all_drivers_exhausted'
  | 'no_delivery_point';

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
 * Re-oferta: un chofer cuya oferta VENCIÓ vuelve a ser candidato del mismo
 * pedido pasado `REOFFER_COOLDOWN_MS` desde ese vencimiento, pero sólo si no
 * hay choferes nuevos (los nunca contactados van siempre primero). Quien
 * RECHAZÓ (o ya aceptó y liberó) no recibe nunca más ese pedido. Si no queda
 * ningún candidato, se avisa a los admins con `order:no-drivers`, una vez por
 * agotamiento.
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

  /**
   * Espera, desde que venció su oferta, antes de volver a ofrecerle el mismo
   * pedido a un chofer. Constante del despacho (no es parámetro por
   * distribuidora: `module_config` sólo admite los procesos de
   * `ConfigurableProcess`).
   */
  static readonly REOFFER_COOLDOWN_MS = 3 * 60 * 1000;

  /**
   * Vigencia inicial del lock que serializa la oferta de un pedido; Redlock lo
   * extiende solo mientras la sección crítica siga corriendo.
   */
  private static readonly OFFER_LOCK_TTL_MS = 5000;

  /** Tope de la marca de "ya avisé que no hay choferes" (se borra al ofrecer). */
  private static readonly NO_DRIVERS_MARK_TTL_SEC = 24 * 60 * 60;

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
    private readonly redis: RedisService,
  ) {}

  /**
   * Ofrece el pedido al chofer más cercano que aún no haya sido contactado o,
   * si no queda ninguno, al más cercano cuya oferta venció hace más que el
   * cooldown. Serializa por pedido (lock distribuido) y no crea una oferta si
   * ya hay una OFFERED vigente. Best-effort: si no hay candidatos avisa a los
   * admins (una vez) y no hace nada; el cron reintenta. Devuelve el driver_id
   * ofrecido, o null si no hubo.
   */
  async offerToNextDriver(order: Order): Promise<string | null> {
    const res = await this.redis.withLock(
      `dispatch:offer:${order.orderId}`,
      DispatchOrchestratorService.OFFER_LOCK_TTL_MS,
      () => this.offerLocked(order),
    );
    // Si otro proceso está ofreciendo este mismo pedido ahora mismo, no se ofrece.
    return res.obtenido ? res.valor : null;
  }

  private async offerLocked(order: Order): Promise<string | null> {
    // Estado fresco DENTRO del lock: entre que el caller leyó el pedido y acá
    // pudo aceptarse, asignarse o cancelarse.
    const fresco = await this.orders.findByIdFull(order.orderId);
    if (!fresco || !this.isReofferable(fresco)) return null;
    if (await this.offers.hasActiveOffer(order.orderId)) return null;

    const destino = coordenadasDePunto(order.deliveryPoint);
    // Sin punto de entrega no hay contra qué medir la cercanía: se avisa al
    // panel en vez de quedar en silencio.
    if (!destino) {
      await this.avisarSinChoferes(order, 'no_delivery_point');
      return null;
    }

    const { blocked, reofferable } = await this.offers.findDriverOfferState(
      order.orderId,
      new Date(),
      DispatchOrchestratorService.REOFFER_COOLDOWN_MS,
    );
    const nuncaContactadosOBloqueados = new Set([...blocked, ...reofferable]);

    // Primero los nunca contactados; la re-oferta es el último recurso.
    const nuevos = await this.findNearestAvailable(
      destino.lat,
      destino.lng,
      nuncaContactadosOBloqueados,
      order.distributorId,
    );
    const candidate =
      nuevos.candidate ??
      (reofferable.length > 0
        ? (
            await this.findNearestAvailable(
              destino.lat,
              destino.lng,
              new Set(blocked),
              order.distributorId,
            )
          ).candidate
        : null);

    if (!candidate) {
      this.logger.debug(
        `Sin choferes elegibles para ${order.orderId} (contactados: ${nuncaContactadosOBloqueados.size})`,
      );
      await this.avisarSinChoferes(
        order,
        nuevos.elegiblesEnRango > 0
          ? 'all_drivers_exhausted'
          : 'no_drivers_in_range',
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
    // Un chofer nuevo reabre el pedido: el próximo agotamiento vuelve a avisar.
    // Una re-oferta a quien ya venció es el mismo agotamiento y no lo reinicia
    // (si no, con un solo chofer el aviso se repetiría en cada vuelta).
    if (!reofferable.includes(candidate)) {
      await this.redis.del(this.claveSinChoferes(order.orderId));
    }

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

  private claveSinChoferes(orderId: string): string {
    return `dispatch:no-drivers:${orderId}`;
  }

  /**
   * Avisa al panel (`order:no-drivers`) que un pedido pendiente no tiene a
   * quién ofrecerse. Una vez por agotamiento: la marca en Redis evita repetirlo
   * en cada tick del cron y se borra cuando el pedido consigue una oferta.
   */
  private async avisarSinChoferes(
    order: Order,
    reason: MotivoSinChoferes,
  ): Promise<void> {
    const primeraVez = await this.redis.setIfAbsent(
      this.claveSinChoferes(order.orderId),
      DispatchOrchestratorService.NO_DRIVERS_MARK_TTL_SEC,
    );
    if (!primeraVez) return;
    this.dispatch.notifyAdmins(
      'order:no-drivers',
      {
        orderId: order.orderId,
        distributorId: order.distributorId ?? null,
        reason,
        at: new Date().toISOString(),
      },
      order.distributorId,
    );
    this.logger.warn(`Pedido ${order.orderId} sin choferes (${reason})`);
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
    // `offerToNextDriver` no ofrece si ya hay una oferta OFFERED vigente.
    await this.offerToNextDriver(order);
  }

  /**
   * El chofer aceptó: queda constancia ACCEPTED (cierra su oferta activa o,
   * si ya había vencido, la registra) y se limpia el aviso de agotamiento.
   */
  async onDriverAccepted(orderId: string, driverId: string): Promise<void> {
    await this.offers.recordDriverHeldOrder(orderId, driverId);
    await this.onOrderClosed(orderId);
  }

  /**
   * Un admin asignó el pedido a mano: el chofer asignado queda como quien lo
   * tuvo (no se le vuelve a ofrecer si lo libera) y se limpia el aviso.
   */
  async onOrderAssigned(orderId: string, driverId: string): Promise<void> {
    await this.offers.recordDriverHeldOrder(orderId, driverId);
    await this.onOrderClosed(orderId);
  }

  /**
   * El pedido se resolvió (aceptado, asignado, cancelado o liberado): borra la
   * marca de "sin choferes" para que un agotamiento futuro vuelva a avisar.
   */
  async onOrderClosed(orderId: string): Promise<void> {
    await this.redis.del(this.claveSinChoferes(orderId));
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
   * mano): deja constancia ACCEPTED de que ESE chofer tuvo el pedido (cierra
   * su OFFERED si quedó alguna, o la inserta si falló el registro al aceptar o
   * fue una asignación manual), así nunca se le vuelve a ofrecer. No re-ofrece: quien libera decide aparte si el
   * pedido vuelve al pool.
   */
  async releaseOffer(orderId: string, driverId: string): Promise<void> {
    await this.offers.recordDriverHeldOrder(orderId, driverId);
    await this.onOrderClosed(orderId);
  }

  /** Solo se re-ofrece un pedido pendiente y sin chofer asignado. */
  private isReofferable(order: Order): boolean {
    return order.status === OrderStatus.PENDING && !order.deliveryId;
  }

  /**
   * Primer chofer (más cercano) dentro del radio progresivo que no esté en
   * `exclude`. `getNearbyDrivers` ya devuelve ordenado por cercanía (ASC).
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
  ): Promise<{ candidate: string | null; elegiblesEnRango: number }> {
    const cacheDeFlota: CacheDeInhabilitacion = {
      evaluados: new Set(),
      inhabilitados: new Set(),
    };
    const enRango = new Set<string>();

    for (const radiusKm of DispatchOrchestratorService.RADIUS_STEPS_KM) {
      const drivers = await this.dispatch.findNearbyDrivers(lat, lng, radiusKm);
      const eligible = await this.filterEligible(
        drivers,
        distributorId,
        cacheDeFlota,
      );
      eligible.forEach((id) => enRango.add(id));
      const next = eligible.find((id) => !exclude.has(id));
      if (next) return { candidate: next, elegiblesEnRango: enRango.size };
    }
    return { candidate: null, elegiblesEnRango: enRango.size };
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
