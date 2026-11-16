import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { errorMessage } from '../../common/errors/error-message';
import { RedisService } from '../../redis/redis.service';
import { MpReconciliationService } from './mp-reconciliation.service';
import { ConRegistro } from '../../process-run/process-run.recorder';
import {
  marcarSaltada,
  registrarErrorAtrapado,
} from '../../process-run/process-run.context';
import { ProcessName } from '../../process-run/domain/process-catalog';

/**
 * Cada dos minutos le pregunta a Mercado Pago por los reportes de liberaciones
 * que se pidieron y todavía no se concilió. Mantenimiento del sistema: una sola
 * instancia por vez (cerrojo distribuido).
 */
@Injectable()
export class MpReconciliationCron {
  static readonly CERROJO = 'cron:mp-reconciliation';
  static readonly CERROJO_TTL_MS = 5 * 60_000;

  private readonly logger = new Logger(MpReconciliationCron.name);

  constructor(
    private readonly conciliaciones: MpReconciliationService,
    private readonly redis: RedisService,
  ) {}

  @Cron('0 */2 * * * *')
  @ConRegistro(ProcessName.MP_RECONCILIATION_SYNC)
  async sincronizarPendientes() {
    try {
      const bloqueo = await this.redis.withLock(
        MpReconciliationCron.CERROJO,
        MpReconciliationCron.CERROJO_TTL_MS,
        () => this.barrer(),
      );
      if (bloqueo.obtenido) return bloqueo.valor;
      marcarSaltada();
      this.logger.log('Conciliaciones: las está procesando otra instancia');
    } catch (error) {
      registrarErrorAtrapado(error, true);
      this.logger.error(
        `Conciliaciones: la ejecución falló: ${errorMessage(error)}`,
      );
    }
  }

  /** Procesa las pendientes una por una; la falla de una no frena a las demás. Devuelve cuántas revisó. */
  async barrer(): Promise<number> {
    const ids = await this.conciliaciones.idsPendientes();
    for (const id of ids) {
      try {
        await this.conciliaciones.sincronizar(id);
      } catch (error) {
        registrarErrorAtrapado(error);
        this.logger.error(
          `Conciliación ${id}: no se pudo procesar: ${errorMessage(error)}`,
        );
      }
    }
    return ids.length;
  }
}
