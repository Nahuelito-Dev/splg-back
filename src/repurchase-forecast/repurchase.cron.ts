import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { errorMessage } from '../common/errors/error-message';
import {
  minutosDelDiaArgentino,
  ZONA_ARGENTINA,
} from '../common/utils/dias-argentina';
import { DistributorService } from '../distributor/distributor.service';
import { DistributorStatus } from '../distributor/entities/distributor.entity';
import { RedisService } from '../redis/redis.service';
import { RepurchaseEstimatorService } from './repurchase-estimator.service';
import { RepurchaseForecastService } from './repurchase-forecast.service';
import { ConRegistro } from '../process-run/process-run.recorder';
import {
  marcarSaltada,
  registrarErrorAtrapado,
} from '../process-run/process-run.context';
import { ProcessName } from '../process-run/domain/process-catalog';

/**
 * CU-106: el proceso automático de la recompra anticipada.
 *
 * - Cada hora recorre las distribuidoras activas que la tienen encendida
 *   (`enabled`; viene apagada) y corre la anticipación en la que toca
 *   (`runHour`, de 8 a 21; por omisión las 9). Una vez por día.
 * - Cada cinco minutos vence las invitaciones cuya vigencia terminó (sólo en las
 *   que la tienen encendida) y cierra las de las distribuidoras que ya no están
 *   activas.
 *
 * Con varias instancias corre una sola (cerrojo distribuido) y el cerrojo se
 * libera pase lo que pase. La corrida es idempotente: si se repite, no invita
 * dos veces al mismo cliente.
 */
@Injectable()
export class RepurchaseCron {
  static readonly CERROJO_DIARIO = 'cron:repurchase';
  static readonly CERROJO_VENCIMIENTOS = 'cron:repurchase-expiry';
  static readonly CERROJO_TTL_MS = 10 * 60_000;

  private readonly logger = new Logger(RepurchaseCron.name);

  constructor(
    private readonly forecast: RepurchaseForecastService,
    private readonly estimator: RepurchaseEstimatorService,
    private readonly distributors: DistributorService,
    private readonly redis: RedisService,
  ) {}

  @Cron('0 0 * * * *', { timeZone: ZONA_ARGENTINA })
  @ConRegistro(ProcessName.REPURCHASE_ANTICIPATE)
  async anticipar(): Promise<number | undefined> {
    return this.conCerrojo(RepurchaseCron.CERROJO_DIARIO, () =>
      this.anticiparLasQueTocan(new Date()),
    );
  }

  @Cron('0 */5 * * * *')
  @ConRegistro(ProcessName.REPURCHASE_EXPIRY)
  async vencer(): Promise<{ closed: number } | undefined> {
    return this.conCerrojo(RepurchaseCron.CERROJO_VENCIMIENTOS, async () => {
      const ahora = new Date();
      let cerradas = 0;
      for (const d of await this.distributors.findAll()) {
        try {
          if (d.status !== DistributorStatus.ACTIVE) {
            // Una distribuidora que ya no está activa no atiende invitaciones.
            cerradas += await this.forecast.cerrarLasDeUnaDistribuidoraInactiva(
              d.distributorId,
              ahora,
            );
          } else if (
            (await this.estimator.parametros(d.distributorId)).enabled
          ) {
            cerradas += await this.forecast.vencer(ahora, d.distributorId);
          }
        } catch (error) {
          registrarErrorAtrapado(error);
          this.logger.error(
            `Recompra ${d.distributorId}: el barrido falló: ${errorMessage(error)}`,
          );
        }
      }
      if (cerradas > 0) {
        this.logger.log(`Recompra: ${cerradas} invitación(es) cerrada(s)`);
      }
      return { closed: cerradas };
    });
  }

  /** Corre la anticipación de las distribuidoras activas cuya hora de ejecución es la actual. */
  async anticiparLasQueTocan(ahora: Date): Promise<number> {
    const hora = Math.floor(minutosDelDiaArgentino(ahora) / 60);
    const activas = (await this.distributors.findAll()).filter(
      (d) => d.status === DistributorStatus.ACTIVE,
    );
    let corridas = 0;
    for (const { distributorId } of activas) {
      try {
        const params = await this.estimator.parametros(distributorId);
        if (!params.enabled || params.runHour !== hora) continue;
        await this.forecast.ejecutar(distributorId, ahora);
        corridas += 1;
      } catch (error) {
        registrarErrorAtrapado(error);
        this.logger.error(
          `Recompra ${distributorId}: falló: ${errorMessage(error)}`,
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
        RepurchaseCron.CERROJO_TTL_MS,
        fn,
      );
      if (bloqueo.obtenido) return bloqueo.valor;
      marcarSaltada();
      this.logger.log(`Recompra (${clave}): la procesa otra instancia`);
    } catch (error) {
      registrarErrorAtrapado(error, true);
      this.logger.error(
        `Recompra (${clave}): la ejecución falló: ${errorMessage(error)}`,
      );
    }
  }
}
