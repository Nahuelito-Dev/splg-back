import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { errorMessage } from '../../common/errors/error-message';
import { ZONA_ARGENTINA } from '../../common/utils/dias-argentina';
import { RedisService } from '../../redis/redis.service';
import { VehicleUsageFeedService } from './vehicle-usage-feed.service';

/**
 * Alimenta el registro de uso diario de la flota (`vehicle_usage_log`) una vez
 * por día, de madrugada, antes de que corra el planificador. Con varias
 * instancias corre una sola (cerrojo distribuido); es idempotente por
 * vehículo y día.
 */
@Injectable()
export class VehicleUsageCron {
  static readonly CERROJO = 'cron:vehicle-usage-feed';
  static readonly CERROJO_TTL_MS = 10 * 60_000;

  private readonly logger = new Logger(VehicleUsageCron.name);

  constructor(
    private readonly feed: VehicleUsageFeedService,
    private readonly redis: RedisService,
  ) {}

  @Cron('0 30 1 * * *', { timeZone: ZONA_ARGENTINA })
  async alimentar(): Promise<void> {
    try {
      const bloqueo = await this.redis.withLock(
        VehicleUsageCron.CERROJO,
        VehicleUsageCron.CERROJO_TTL_MS,
        () => this.alimentarTodas(),
      );
      if (!bloqueo.obtenido) {
        this.logger.log('Uso de flota: lo está procesando otra instancia');
      }
    } catch (error) {
      this.logger.error(
        `Uso de flota: la ejecución falló: ${errorMessage(error)}`,
      );
    }
  }

  /** Corre todas las distribuidoras; una que falla no frena a las demás. Devuelve cuántas salieron bien. */
  async alimentarTodas(ahora: Date = new Date()): Promise<number> {
    let bien = 0;
    for (const id of await this.feed.distribuidorasConVehiculos()) {
      try {
        await this.feed.alimentar(id, ahora);
        bien += 1;
      } catch (error) {
        this.logger.error(`Uso de flota ${id}: falló: ${errorMessage(error)}`);
      }
    }
    return bien;
  }
}
