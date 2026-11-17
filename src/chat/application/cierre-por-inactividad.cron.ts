import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { errorMessage } from '../../common/errors/error-message';
import { ProcessName } from '../../process-run/domain/process-catalog';
import {
  marcarSaltada,
  registrarElementoBien,
  registrarErrorAtrapado,
  registrarFallaDeElemento,
} from '../../process-run/process-run.context';
import { ConRegistro } from '../../process-run/process-run.recorder';
import { RedisService } from '../../redis/redis.service';
import { CierrePorInactividad } from './cierre-por-inactividad';

export interface ResultadoDelCierrePorInactividad {
  warned: number;
  closed: number;
  /** Las que no se llegaron a mirar (se acabó el tiempo de la corrida). */
  pending: number;
}

/**
 * Cada cinco minutos (una sola instancia, con cerrojo): avisa y cierra las
 * conversaciones de la bandeja que quedaron sin respuesta del cliente o del
 * chofer, según los plazos de cada empresa (tanda 7c). Aparece en el
 * monitoreo como `chat_inactivity_close`. Cada conversación por su lado: la
 * que falla queda para la próxima corrida y no frena a las demás.
 */
@Injectable()
export class CierrePorInactividadCron {
  static readonly CERROJO = 'cron:chat-inactivity-close';
  static readonly CERROJO_TTL_MS = 4 * 60_000;
  /** Tiempo de barrido por corrida: termina bien antes de que venza el cerrojo. */
  static readonly PRESUPUESTO_MS = 3 * 60_000;

  private readonly logger = new Logger(CierrePorInactividadCron.name);

  constructor(
    private readonly redis: RedisService,
    private readonly cierre: CierrePorInactividad,
  ) {}

  @Cron('30 */5 * * * *')
  @ConRegistro(ProcessName.CHAT_INACTIVITY_CLOSE)
  async cerrar(): Promise<ResultadoDelCierrePorInactividad | undefined> {
    try {
      const bloqueo = await this.redis.withLock(
        CierrePorInactividadCron.CERROJO,
        CierrePorInactividadCron.CERROJO_TTL_MS,
        () => this.barrer(new Date()),
      );
      if (bloqueo.obtenido) return bloqueo.valor;
      marcarSaltada();
      this.logger.log(
        'Cierre por inactividad del chat: lo está procesando otra instancia',
      );
    } catch (error) {
      registrarErrorAtrapado(error, true);
      this.logger.error(
        `Cierre por inactividad del chat: la ejecución falló: ${errorMessage(error)}`,
      );
    }
    return undefined;
  }

  /**
   * Hasta `TOPE_DE_CANDIDATAS` por corrida, y corta antes de que venza el
   * cerrojo (`PRESUPUESTO_MS`, medido con `reloj`): lo que queda va en la
   * siguiente, con el mismo `ahora` de la corrida para todas.
   */
  async barrer(
    ahora: Date,
    reloj: () => number = Date.now,
  ): Promise<ResultadoDelCierrePorInactividad> {
    const resultado: ResultadoDelCierrePorInactividad = {
      warned: 0,
      closed: 0,
      pending: 0,
    };
    const inicio = reloj();
    const candidatas = await this.cierre.candidatas(ahora);
    for (const [i, { id, empresa }] of candidatas.entries()) {
      if (reloj() - inicio > CierrePorInactividadCron.PRESUPUESTO_MS) {
        resultado.pending = candidatas.length - i;
        this.logger.warn(
          `Cierre por inactividad del chat: se acabó el tiempo de la corrida; quedan ${resultado.pending} para la próxima`,
        );
        break;
      }
      try {
        const r = await this.cierre.procesar(id, ahora);
        if (r === 'warned') resultado.warned += 1;
        if (r === 'closed') resultado.closed += 1;
        registrarElementoBien(`conversacion:${id}`);
      } catch (error) {
        registrarFallaDeElemento(`conversacion:${id}`, error);
        this.logger.error(
          `Cierre por inactividad del chat: falló la conversación ${id} de la distribuidora ${empresa}: ${errorMessage(error)}`,
        );
      }
    }
    return resultado;
  }
}
