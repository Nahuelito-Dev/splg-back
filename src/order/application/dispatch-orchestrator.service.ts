import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Order, OrderStatus } from '../entities/order.entity';
import { DispatchOfferStatus } from '../entities/dispatch-offer.entity';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { RealtimeDispatchPort } from '../domain/ports/realtime-dispatch.port';
import { OrderRepositoryPort } from '../domain/ports/order.repository.port';
import { DispatchOfferRepositoryPort } from '../domain/ports/dispatch-offer.repository.port';
import { NotificationsService } from '../../notifications/notifications.service';

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
    @InjectRepository(Delivery)
    private readonly deliveryRepository: Repository<Delivery>,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Ofrece el pedido al chofer más cercano que aún no haya sido contactado.
   * Best-effort: si no hay candidatos, no hace nada (el cron reintentará cuando
   * aparezcan choferes). Devuelve el driver_id ofrecido, o null si no hubo.
   */
  async offerToNextDriver(order: Order): Promise<string | null> {
    const alreadyOffered = new Set(
      await this.offers.findOfferedDriverIds(order.order_id),
    );

    const candidate = await this.findNearestAvailable(
      Number(order.deliveryLatitude),
      Number(order.deliveryLongitude),
      alreadyOffered,
      order.distributor_id,
    );

    if (!candidate) {
      this.logger.debug(
        `Sin choferes nuevos para ${order.order_id} (ya contactados: ${alreadyOffered.size})`,
      );
      return null;
    }

    const expiresAt = new Date(
      Date.now() + DispatchOrchestratorService.OFFER_TTL_SECONDS * 1000,
    );
    await this.offers.create(
      order.order_id,
      candidate,
      expiresAt,
      order.distributor_id,
    );

    this.dispatch.notifyDriverNewOrder(candidate, {
      event: 'NEW_ORDER',
      orderId: order.order_id,
      totalAmount: order.totalAmount,
      paymentMethod: order.paymentMethod,
      expiresAt: expiresAt.toISOString(),
      items: order.items,
    });

    // Push FCM complementario: si el chofer tiene la app cerrada/en background,
    // el socket no llega pero el push sí. Best-effort, no bloquea el dispatch.
    void this.notifications.sendOfferPushToDriver(candidate, order.order_id);

    this.logger.log(
      `Pedido ${order.order_id} ofrecido a chofer ${candidate} (vence ${expiresAt.toISOString()})`,
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
      await this.offers.updateStatus(offer.offer_id, DispatchOfferStatus.EXPIRED);

      // Recargar el pedido: pudo haber sido aceptado/cancelado por otra vía.
      const order = await this.orders.findByIdFull(offer.order_id);
      if (!order || !this.isReofferable(order)) continue;

      this.logger.log(
        `Oferta vencida de ${offer.order_id} (chofer ${offer.driver_id}) → siguiente`,
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
    if (await this.offers.hasActiveOffer(order.order_id)) return;
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
      order.order_id,
      driverId,
      DispatchOfferStatus.REJECTED,
    );
    if (this.isReofferable(order)) {
      await this.offerToNextDriver(order);
    }
  }

  /** Solo se re-ofrece un pedido pendiente y sin chofer asignado. */
  private isReofferable(order: Order): boolean {
    return order.status === OrderStatus.PENDING && !order.delivery_id;
  }

  /**
   * Primer chofer (más cercano) dentro del radio progresivo que no esté ya
   * contactado. `getNearbyDrivers` ya devuelve ordenado por cercanía (ASC).
   * Multi-tenant: si el pedido tiene distribuidora, sólo se consideran choferes
   * de ESA distribuidora (un chofer no recibe ofertas de otro tenant).
   */
  private async findNearestAvailable(
    lat: number,
    lng: number,
    exclude: Set<string>,
    distributorId?: string | null,
  ): Promise<string | null> {
    for (const radiusKm of DispatchOrchestratorService.RADIUS_STEPS_KM) {
      const drivers = await this.dispatch.findNearbyDrivers(lat, lng, radiusKm);
      const eligible = await this.filterByDistributor(drivers, distributorId);
      const next = eligible.find((id) => !exclude.has(id));
      if (next) return next;
    }
    return null;
  }

  /**
   * Restringe una lista de choferes (por cercanía) a los que pertenecen a la
   * distribuidora dada, preservando el orden. Sin distribuidora, no filtra.
   * `driver_id` de la oferta = `user_id` del chofer = `delivery.user_id`.
   */
  private async filterByDistributor(
    driverIds: string[],
    distributorId?: string | null,
  ): Promise<string[]> {
    if (!distributorId || driverIds.length === 0) return driverIds;
    const rows = await this.deliveryRepository.find({
      where: { user_id: In(driverIds), distributor_id: distributorId },
      select: { user_id: true },
    });
    const allowed = new Set(rows.map((r) => r.user_id));
    return driverIds.filter((id) => allowed.has(id));
  }
}
