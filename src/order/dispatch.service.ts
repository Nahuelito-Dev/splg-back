import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OrderService } from './order.service';
import { RedisService } from '../redis/redis.service';
import { DispatchOrchestratorService } from './application/dispatch-orchestrator.service';

/**
 * Motor de tiempo del despacho secuencial. Corre cada 15s y, tomando un lock
 * distribuido (una sola instancia por tick):
 *   1. vence las ofertas que pasaron su ventana de 30s y las re-ofrece al
 *      siguiente chofer más cercano (DispatchOrchestrator.handleExpiredOffers);
 *   2. arranca pedidos pendientes que quedaron sin oferta activa (ej: al crearse
 *      no había choferes cerca) con DispatchOrchestrator.ensureOffered.
 *
 * La lógica de a-quién-ofrecer vive en el orquestador; este servicio solo aporta
 * el reloj y el lock multi-instancia.
 */
@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  /** No re-ofrecer pedidos recién creados (el create ya los ofreció). */
  private static readonly MIN_AGE_MS = 60 * 1000;

  constructor(
    private readonly orderService: OrderService,
    private readonly redisService: RedisService,
    private readonly orchestrator: DispatchOrchestratorService,
  ) {}

  @Cron('*/15 * * * * *') // cada 15 segundos
  async tick() {
    // Distributed lock: solo una instancia procesa por tick. TTL 12s < 15s para
    // que si crashea sin liberar, expire antes del próximo tick.
    const lock = await this.redisService.acquireLock('dispatch:tick', 12000);
    if (!lock) return;

    try {
      await this.orchestrator.handleExpiredOffers();
      await this.bootstrapPendingWithoutOffer();
    } catch (err) {
      this.logger.error(`tick de dispatch falló: ${(err as Error)?.message}`);
    } finally {
      await lock.release().catch(() => undefined);
    }
  }

  /** Ofrece a pedidos pendientes (con antigüedad mínima) que no tienen oferta. */
  private async bootstrapPendingWithoutOffer(): Promise<void> {
    const { orders } = await this.orderService.findAvailableOrders({
      limit: 50,
      offset: 0,
    });
    const staleBefore = new Date(Date.now() - DispatchService.MIN_AGE_MS);

    for (const order of orders) {
      if (new Date(order.createdAt) > staleBefore) continue;
      await this.orchestrator.ensureOffered(order);
    }
  }
}
