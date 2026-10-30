import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../../redis/redis.service';
import { errorMessage } from '../../common/errors/error-message';
import {
  minutosDelDiaArgentino,
  ZONA_ARGENTINA,
} from '../../common/utils/dias-argentina';
import { MaintenancePlannerService } from './maintenance-planner.service';

/**
 * CU-105: el proceso automático del planificador de flota.
 *
 * - Cada hora recorre las distribuidoras y corre la planificación en la que
 *   toca (`cronHour`, por distribuidora; por omisión las 3). Una vez por día.
 * - Cada cinco minutos vence las propuestas sin respuesta y ofrece la siguiente
 *   ventana, o escala.
 *
 * Con varias instancias corre una sola (cerrojo distribuido) y el cerrojo se
 * libera pase lo que pase.
 */
@Injectable()
export class MaintenancePlannerCron {
  static readonly CERROJO_DIARIO = 'cron:fleet-planner';
  static readonly CERROJO_VENCIMIENTOS = 'cron:fleet-planner-expiry';
  static readonly CERROJO_TTL_MS = 10 * 60_000;

  private readonly logger = new Logger(MaintenancePlannerCron.name);

  constructor(
    private readonly planner: MaintenancePlannerService,
    private readonly redis: RedisService,
  ) {}

  @Cron('0 0 * * * *', { timeZone: ZONA_ARGENTINA })
  async planificar(): Promise<void> {
    await this.conCerrojo(MaintenancePlannerCron.CERROJO_DIARIO, async () => {
      await this.planificarLasQueTocan(new Date());
    });
  }

  @Cron('0 */5 * * * *')
  async vencerPropuestas(): Promise<void> {
    await this.conCerrojo(
      MaintenancePlannerCron.CERROJO_VENCIMIENTOS,
      async () => {
        const n = await this.planner.vencerPropuestas(new Date());
        if (n > 0)
          this.logger.log(`Planificador: ${n} propuesta(s) vencida(s)`);
      },
    );
  }

  /** Corre la planificación de las distribuidoras cuya hora de ejecución es la actual. */
  async planificarLasQueTocan(ahora: Date): Promise<number> {
    const hora = Math.floor(minutosDelDiaArgentino(ahora) / 60);
    const ids = await this.planner.distribuidorasConTareas();
    let corridas = 0;
    for (const distributorId of ids) {
      try {
        const params = await this.planner.parametros(distributorId);
        if (params.cronHour !== hora) continue;
        const r = await this.planner.ejecutar(distributorId, ahora);
        corridas += 1;
        this.logger.log(
          `Planificador ${distributorId}: ${r.propuestas} propuesta(s), ${r.escaladas} escalada(s), ${r.vehiculosFueraDeServicio} fuera de servicio`,
        );
      } catch (error) {
        this.logger.error(
          `Planificador ${distributorId}: falló: ${errorMessage(error)}`,
        );
      }
    }
    return corridas;
  }

  private async conCerrojo(
    clave: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    try {
      const bloqueo = await this.redis.withLock(
        clave,
        MaintenancePlannerCron.CERROJO_TTL_MS,
        fn,
      );
      if (!bloqueo.obtenido) {
        this.logger.log(
          `Planificador (${clave}): lo está procesando otra instancia`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Planificador (${clave}): la ejecución falló: ${errorMessage(error)}`,
      );
    }
  }
}
