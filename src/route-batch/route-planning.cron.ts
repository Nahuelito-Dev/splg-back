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
import { RoutePlanProposalService } from './application/route-plan-proposal.service';
import { RoutePlanService } from './application/route-plan.service';

/**
 * Hoja de ruta (F34, §10): la propuesta automática de mañana al cierre (18:00
 * por omisión, `route_planning.cutoffHour`) y el cierre solo de los días que
 * llegaron (00:00 de D). Con varias instancias corre una sola (cerrojo).
 */
@Injectable()
export class RoutePlanningCron {
  static readonly CERROJO_PROPONER = 'cron:route-planning:propose';
  static readonly CERROJO_CERRAR = 'cron:route-planning:close-days';
  static readonly CERROJO_TTL_MS = 10 * 60_000;

  private readonly logger = new Logger(RoutePlanningCron.name);

  constructor(
    private readonly plans: RoutePlanService,
    private readonly proposal: RoutePlanProposalService,
    private readonly redis: RedisService,
  ) {}

  @Cron('0 * * * * *')
  @ConRegistro(ProcessName.ROUTE_PLANNING_PROPOSE)
  proponer(): Promise<{ proposed: number } | undefined> {
    return this.conCerrojo(RoutePlanningCron.CERROJO_PROPONER, () =>
      this.proponerLasQueTocan(new Date()),
    );
  }

  @Cron('0 */5 * * * *')
  @ConRegistro(ProcessName.ROUTE_PLANNING_CLOSE_DAYS)
  cerrarDias(): Promise<{ closed: number } | undefined> {
    return this.conCerrojo(RoutePlanningCron.CERROJO_CERRAR, async () => ({
      closed: await this.plans.cerrarDiasVencidos(new Date()),
    }));
  }

  /** Propone mañana en las distribuidoras cuyo cierre pasó; una que falla no frena a las demás. */
  async proponerLasQueTocan(ahora: Date): Promise<{ proposed: number }> {
    let proposed = 0;
    for (const { distributorId, planDate } of await this.plans.paraProponer(
      ahora,
    )) {
      try {
        const r = await this.proposal.proponer(distributorId, planDate);
        proposed += 1;
        this.logger.log(
          `Hoja de ruta ${distributorId} ${planDate}: ${r.sheets.length} hoja(s), ${r.unassigned.length} sin asignar`,
        );
      } catch (error) {
        registrarErrorAtrapado(error);
        this.logger.error(
          `Hoja de ruta ${distributorId} ${planDate}: falló la propuesta: ${errorMessage(error)}`,
        );
      }
    }
    return { proposed };
  }

  private async conCerrojo<T>(
    clave: string,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      const r = await this.redis.withLock(
        clave,
        RoutePlanningCron.CERROJO_TTL_MS,
        fn,
      );
      if (r.obtenido) return r.valor;
      marcarSaltada();
      this.logger.log(
        `Hoja de ruta (${clave}): la está procesando otra instancia`,
      );
    } catch (error) {
      registrarErrorAtrapado(error, true);
      this.logger.error(
        `Hoja de ruta (${clave}): la ejecución falló: ${errorMessage(error)}`,
      );
    }
  }
}
