import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OrderService } from './order.service';
import { RedisService } from '../redis/redis.service';
import { DispatchOrchestratorService } from './application/dispatch-orchestrator.service';
import { RefundsService } from '../payments/application/refunds.service';
import { ScheduledTasksSettingsService } from '../distributor/scheduled-tasks-settings.service';
import { ConRegistro } from '../process-run/process-run.recorder';
import {
  marcarSaltada,
  registrarErrorAtrapado,
} from '../process-run/process-run.context';
import { ProcessName } from '../process-run/domain/process-catalog';

/**
 * Motor de tiempo del despacho secuencial. Corre cada 15s y, tomando un lock
 * distribuido (una sola instancia por tick):
 *   1. vence las ofertas que pasaron su ventana y las re-ofrece al
 *      siguiente chofer más cercano (DispatchOrchestrator.handleExpiredOffers);
 *   2. arranca pedidos pendientes que quedaron sin oferta activa (ej: al crearse
 *      no había choferes cerca) con DispatchOrchestrator.ensureOffered;
 *   3. retoma las devoluciones `pending` viejas (RefundsService.retomarPendientes).
 *
 * Las ofertas vencidas de un pedido express se procesan en CADA tic, sin esperar
 * el intervalo de la distribuidora.
 *
 * El tic de 15s es fijo; la frecuencia de cada distribuidora (CU-173,
 * `dispatchRetrySeconds`) es múltiplo de él y en cada tic se atiende sólo a las
 * que les toca.
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
    private readonly frecuencias: ScheduledTasksSettingsService,
    private readonly refunds: RefundsService,
  ) {}

  @Cron('*/15 * * * * *') // cada 15 segundos
  @ConRegistro(ProcessName.DISPATCH_TICK)
  async tick() {
    // Distributed lock: solo una instancia procesa por tick. TTL 12s < 15s para
    // que si crashea sin liberar, expire antes del próximo tick.
    const lock = await this.redisService.acquireLock('dispatch:tick', 12000);
    if (!lock) {
      marcarSaltada();
      return;
    }

    // Al empezar el tic, de una sola pasada: a qué distribuidoras les toca
    // (con trabajo pendiente). Sus marcas quedan puestas desde ahora.
    let corren = new Set<string>();
    try {
      const candidatas = new Set([
        ...(await this.orchestrator.distribuidorasConOfertasVencidas()),
        ...(await this.orderService.distribuidorasConPedidosDisponibles()),
      ]);
      corren = await this.frecuencias.distribuidorasQueCorren(
        'dispatchRetrySeconds',
        [...candidatas],
      );
      await this.orchestrator.handleExpiredOffers(corren);
      await this.bootstrapPendingWithoutOffer(corren);
    } catch (err) {
      registrarErrorAtrapado(err, true);
      this.logger.error(`tick de dispatch falló: ${(err as Error)?.message}`);
      // Las distribuidoras que no se llegaron a procesar no pierden su intervalo.
      for (const id of corren) {
        await this.frecuencias
          .liberarMarca('dispatchRetrySeconds', id)
          .catch(() => undefined);
      }
    }

    // Devoluciones que quedaron a medias (se cayó el proceso entre registrarlas y
    // hablar con la pasarela): se retoman con el lock de este mismo tic.
    try {
      await this.refunds.retomarPendientes();
    } catch (err) {
      registrarErrorAtrapado(err);
      this.logger.error(
        `retomar devoluciones falló: ${(err as Error)?.message}`,
      );
    } finally {
      await lock.release().catch(() => undefined);
    }
    return { distributors: corren.size };
  }

  /**
   * Ofrece a pedidos pendientes (con antigüedad mínima) que no tienen oferta.
   * El límite es por distribuidora: ninguna tapa a otra.
   */
  private async bootstrapPendingWithoutOffer(
    distribuidoras: ReadonlySet<string>,
  ): Promise<void> {
    const staleBefore = new Date(Date.now() - DispatchService.MIN_AGE_MS);

    for (const distributorId of distribuidoras) {
      const { orders } = await this.orderService.findAvailableOrders(
        { limit: 50, offset: 0 },
        distributorId,
        true,
      );
      for (const order of orders) {
        if (new Date(order.createdAt) > staleBefore) continue;
        await this.orchestrator.ensureOffered(order);
      }
    }
  }
}
