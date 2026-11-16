import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { errorMessage } from '../common/errors/error-message';
import { ProcessName } from '../process-run/domain/process-catalog';
import {
  marcarSaltada,
  registrarErrorAtrapado,
} from '../process-run/process-run.context';
import { ConRegistro } from '../process-run/process-run.recorder';
import { RedisService } from '../redis/redis.service';
import { AsistenteIaService } from './asistente-ia.service';

/**
 * Rescate del asistente con IA, cada minuto (una sola instancia, con
 * cerrojo): los mensajes que la IA tenía que atender y cuyo trabajo no corrió
 * reciben la respuesta fija que corresponda y pasan a una persona
 * (`AsistenteIaService.rescatarSinAtender`). Sin consultar al modelo.
 * Aparece en el monitoreo de procesos (`assistant_ai_sweep`).
 */
@Injectable()
export class AsistenteIaRescateCron {
  static readonly CERROJO = 'cron:assistant-ai-sweep';
  static readonly CERROJO_TTL_MS = 55_000;

  private readonly logger = new Logger(AsistenteIaRescateCron.name);

  constructor(
    private readonly redis: RedisService,
    private readonly asistente: AsistenteIaService,
  ) {}

  @Cron('0 * * * * *') // cada minuto
  @ConRegistro(ProcessName.ASSISTANT_AI_SWEEP)
  async rescatar(): Promise<{ handedOff: number } | undefined> {
    try {
      const bloqueo = await this.redis.withLock(
        AsistenteIaRescateCron.CERROJO,
        AsistenteIaRescateCron.CERROJO_TTL_MS,
        () => this.asistente.rescatarSinAtender(new Date()),
      );
      if (bloqueo.obtenido) {
        if (bloqueo.valor > 0) {
          this.logger.log(
            `Rescate del asistente: ${bloqueo.valor} mensaje(s) sin atender pasaron a una persona`,
          );
        }
        return { handedOff: bloqueo.valor };
      }
      marcarSaltada();
      this.logger.log(
        'Rescate del asistente: lo está procesando otra instancia',
      );
    } catch (error) {
      registrarErrorAtrapado(error, true);
      this.logger.error(
        `Rescate del asistente: la ejecución falló: ${errorMessage(error)}`,
      );
    }
    return undefined;
  }
}
