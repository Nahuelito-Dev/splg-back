import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RedisService } from '../../redis/redis.service';
import { errorMessage } from '../../common/errors/error-message';
import { ZONA_ARGENTINA } from '../../common/utils/dias-argentina';
import { MaintenancePlannerService } from './maintenance-planner.service';
import {
  marcarCorridaDeHoy,
  tocaCorrerHoy,
  ultimaCorridaDeLaEmpresa,
} from '../../common/utils/corrida-diaria';
import { ConRegistro } from '../../process-run/process-run.recorder';
import {
  marcarSaltada,
  registrarErrorAtrapado,
} from '../../process-run/process-run.context';
import { ProcessName } from '../../process-run/domain/process-catalog';
import { EmpresasParaProceso } from '../../process-run/empresas-para-proceso';

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
    private readonly empresas: EmpresasParaProceso,
  ) {}

  @Cron('0 0 * * * *', { timeZone: ZONA_ARGENTINA })
  @ConRegistro(ProcessName.FLEET_PLANNER_DAILY)
  async planificar(): Promise<number | undefined> {
    return this.conCerrojo(MaintenancePlannerCron.CERROJO_DIARIO, () =>
      this.planificarLasQueTocan(new Date()),
    );
  }

  @Cron('0 */5 * * * *')
  @ConRegistro(ProcessName.FLEET_PLANNER_EXPIRY)
  async vencerPropuestas(): Promise<{ expired: number } | undefined> {
    return this.conCerrojo(
      MaintenancePlannerCron.CERROJO_VENCIMIENTOS,
      async () => {
        const n = await this.planner.vencerPropuestas(new Date());
        if (n > 0)
          this.logger.log(`Planificador: ${n} propuesta(s) vencida(s)`);
        return { expired: n };
      },
    );
  }

  /**
   * Corre la planificación de las distribuidoras cuya hora de ejecución es la
   * actual y que tienen el planificador habilitado por la plataforma (módulo
   * `fleet_planner`). Con el módulo apagado no se generan propuestas nuevas;
   * las pendientes vencen solas (`vencerPropuestas`).
   */
  async planificarLasQueTocan(ahora: Date): Promise<number> {
    const { empresas } = await this.empresas.recorrer(
      {
        proceso: ProcessName.FLEET_PLANNER_DAILY,
        modulo: 'fleet_planner',
        crea: true,
        entre: await this.planner.distribuidorasConTareas(),
      },
      async (distributorId, empresa) => {
        const params = await this.planner.parametros(distributorId);
        if (
          !tocaCorrerHoy(
            ahora,
            params.cronHour,
            await ultimaCorridaDeLaEmpresa(
              this.redis,
              ProcessName.FLEET_PLANNER_DAILY,
              distributorId,
            ),
          )
        )
          return false;
        // Sin caché, justo antes de proponer (§6.3).
        if (!(await empresa.sigueHabilitada())) return false;
        const r = await this.planner.ejecutar(distributorId, ahora);
        await marcarCorridaDeHoy(
          this.redis,
          ProcessName.FLEET_PLANNER_DAILY,
          distributorId,
          ahora,
        );
        this.logger.log(
          `Planificador ${distributorId}: ${r.propuestas} propuesta(s), ${r.escaladas} escalada(s), ${r.vehiculosFueraDeServicio} fuera de servicio`,
        );
        return true;
      },
    );
    return empresas.filter((e) => e.valor === true).length;
  }

  private async conCerrojo<T>(
    clave: string,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      const bloqueo = await this.redis.withLock(
        clave,
        MaintenancePlannerCron.CERROJO_TTL_MS,
        fn,
      );
      if (bloqueo.obtenido) return bloqueo.valor;
      marcarSaltada();
      this.logger.log(
        `Planificador (${clave}): lo está procesando otra instancia`,
      );
    } catch (error) {
      registrarErrorAtrapado(error, true);
      this.logger.error(
        `Planificador (${clave}): la ejecución falló: ${errorMessage(error)}`,
      );
    }
  }
}
