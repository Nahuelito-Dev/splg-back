import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { errorMessage } from '../common/errors/error-message';
import { RedisService } from '../redis/redis.service';
import { RouteBatchService } from './route-batch.service';
import { ConRegistro } from '../process-run/process-run.recorder';
import {
  marcarSaltada,
  registrarErrorAtrapado,
} from '../process-run/process-run.context';
import { ProcessName } from '../process-run/domain/process-catalog';

/**
 * CU-107: el proceso automático de la agrupación por recorrido.
 *
 * - Cada minuto recorre las distribuidoras con pedidos programados sin chofer
 *   y, en las que tienen el módulo encendido (`enabled`), arma lotes si ya cumplieron su frecuencia
 *   (`evaluationFrequencyMinutes`, por distribuidora): una marca en Redis con
 *   esa duración dice cuándo les toca de nuevo.
 * - Cada 15 segundos vence las ofertas sin respuesta (también con el módulo apagado: si se apaga con lotes vivos, se terminan de cerrar solos) y ofrece el lote al
 *   siguiente chofer (el mismo ritmo del despacho individual).
 *
 * Con varias instancias corre una sola (cerrojo distribuido).
 */
@Injectable()
export class RouteBatchCron {
  static readonly CERROJO_ARMADO = 'cron:route-batch';
  static readonly CERROJO_VENCIMIENTOS = 'cron:route-batch-expiry';
  static readonly CERROJO_TTL_MS = 10 * 60_000;
  /** Cuánto antes de cumplirse la frecuencia se acepta el tic siguiente (el tic dura un minuto). */
  static readonly HOLGURA_SEGUNDOS = 5;

  private readonly logger = new Logger(RouteBatchCron.name);

  constructor(
    private readonly service: RouteBatchService,
    private readonly redis: RedisService,
  ) {}

  @Cron('0 * * * * *')
  @ConRegistro(ProcessName.ROUTE_BATCH_BUILD)
  async armar(): Promise<number | undefined> {
    return this.conCerrojo(RouteBatchCron.CERROJO_ARMADO, () =>
      this.armarLasQueTocan(new Date()),
    );
  }

  @Cron('*/15 * * * * *')
  @ConRegistro(ProcessName.ROUTE_BATCH_EXPIRY)
  async vencer() {
    return this.conCerrojo(RouteBatchCron.CERROJO_VENCIMIENTOS, async () => {
      const r = await this.service.vencerOfertas(new Date());
      if (r.expired + r.rescued + r.completed > 0) {
        this.logger.log(
          `Recorridos: ${r.expired} oferta(s) vencida(s), ${r.rescued} lote(s) retomado(s), ${r.completed} completado(s)`,
        );
      }
      return {
        expired: r.expired,
        rescued: r.rescued,
        completed: r.completed,
      };
    });
  }

  /** Arma lotes en las distribuidoras a las que les toca; devuelve cuántas corrieron. */
  async armarLasQueTocan(ahora: Date): Promise<number> {
    const ids = await this.service.distribuidorasConProgramados();
    let corridas = 0;
    for (const distributorId of ids) {
      try {
        const { enabled, evaluationFrequencyMinutes } =
          await this.service.parametros(distributorId);
        // Apagado (por omisión): ni se arma ni se consume la marca de frecuencia.
        if (enabled !== 1) continue;
        const segundos =
          evaluationFrequencyMinutes * 60 - RouteBatchCron.HOLGURA_SEGUNDOS;
        const clave = `route-batch:cada:${distributorId}`;
        const leToca = await this.redis.setIfAbsent(clave, segundos);
        if (!leToca) continue;
        const r = await this.service.evaluar(distributorId, ahora);
        if (!r) {
          // Otra instancia la está armando: la marca no se gasta.
          await this.redis.del(clave);
          continue;
        }
        corridas += 1;
        if (r.batches > 0) {
          this.logger.log(
            `Recorridos ${distributorId}: ${r.batches} lote(s) con ${r.orders} pedido(s) de ${r.candidates} candidato(s)`,
          );
        }
      } catch (error) {
        registrarErrorAtrapado(error);
        this.logger.error(
          `Recorridos ${distributorId}: falló: ${errorMessage(error)}`,
        );
      }
    }
    return corridas;
  }

  private async conCerrojo<T>(
    clave: string,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      const bloqueo = await this.redis.withLock(
        clave,
        RouteBatchCron.CERROJO_TTL_MS,
        fn,
      );
      if (bloqueo.obtenido) return bloqueo.valor;
      marcarSaltada();
      this.logger.log(
        `Recorridos (${clave}): lo está procesando otra instancia`,
      );
    } catch (error) {
      registrarErrorAtrapado(error, true);
      this.logger.error(
        `Recorridos (${clave}): la ejecución falló: ${errorMessage(error)}`,
      );
    }
  }
}
