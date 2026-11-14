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
import {
  ResumenDeConfirmacion,
  RoutePlanAutoConfirmService,
} from './application/route-plan-auto-confirm.service';
import { RoutePlanProposalService } from './application/route-plan-proposal.service';
import { RoutePlanService } from './application/route-plan.service';
import {
  ResumenDeSeguimiento,
  RouteSheetWatchService,
} from './application/route-sheet-watch.service';

/**
 * Hoja de ruta (F34, §10): la propuesta automática de mañana al cierre (18:00
 * por omisión, `route_planning.cutoffHour`) y su confirmación automática al
 * vencer la ventana de revisión (`reviewMinutes`), el cierre solo de los días que
 * llegaron (00:00 de D) y el seguimiento de las hojas en curso. Con varias instancias corre una sola (cerrojo).
 */
@Injectable()
export class RoutePlanningCron {
  static readonly CERROJO_PROPONER = 'cron:route-planning:propose';
  static readonly CERROJO_CERRAR = 'cron:route-planning:close-days';
  static readonly CERROJO_SEGUIR = 'cron:route-planning:watch';
  static readonly CERROJO_TTL_MS = 10 * 60_000;

  private readonly logger = new Logger(RoutePlanningCron.name);

  constructor(
    private readonly plans: RoutePlanService,
    private readonly proposal: RoutePlanProposalService,
    private readonly redis: RedisService,
    private readonly watch: RouteSheetWatchService,
    private readonly autoConfirm: RoutePlanAutoConfirmService,
  ) {}

  /**
   * Propone mañana donde pasó el cierre y, en la misma pasada, confirma solos
   * los borradores cuya ventana de revisión venció (`autoConfirm`,
   * `reviewMinutes`; con 0 minutos, los recién propuestos).
   */
  @Cron('0 * * * * *')
  @ConRegistro(ProcessName.ROUTE_PLANNING_PROPOSE)
  proponer(): Promise<
    | ({ proposed: number; noVehiclesAlerts: number } & ResumenDeConfirmacion)
    | undefined
  > {
    return this.conCerrojo(RoutePlanningCron.CERROJO_PROPONER, async () => {
      const propuesta = await this.proponerLasQueTocan(new Date());
      // La hora se toma después de proponer: con `reviewMinutes = 0` lo recién
      // propuesto ya está vencido.
      const confirmacion = await this.autoConfirm.confirmarLasVencidas(
        new Date(),
      );
      return { ...propuesta, ...confirmacion };
    });
  }

  @Cron('0 */5 * * * *')
  @ConRegistro(ProcessName.ROUTE_PLANNING_CLOSE_DAYS)
  cerrarDias(): Promise<{ closed: number } | undefined> {
    return this.conCerrojo(RoutePlanningCron.CERROJO_CERRAR, async () => ({
      closed: await this.plans.cerrarDiasVencidos(new Date()),
    }));
  }

  /**
   * Hojas en curso (E4/E5): saca las paradas cuyo pedido ya no es del chofer,
   * cierra las terminadas, recalcula la hora estimada por reloj y avisa las
   * confirmadas de hoy que no arrancaron.
   */
  @Cron('30 * * * * *')
  @ConRegistro(ProcessName.ROUTE_SHEET_WATCH)
  seguir(): Promise<ResumenDeSeguimiento | undefined> {
    return this.conCerrojo(RoutePlanningCron.CERROJO_SEGUIR, () =>
      this.watch.vigilar(Date.now()),
    );
  }

  /** Propone mañana en las distribuidoras cuyo cierre pasó; una que falla no frena a las demás. */
  async proponerLasQueTocan(
    ahora: Date,
  ): Promise<{ proposed: number; noVehiclesAlerts: number }> {
    let proposed = 0;
    let noVehiclesAlerts = 0;
    for (const { distributorId, planDate } of await this.plans.paraProponer(
      ahora,
    )) {
      try {
        const r = await this.proposal.proponer(distributorId, planDate);
        proposed += 1;
        this.logger.log(
          `Hoja de ruta ${distributorId} ${planDate}: ${r.sheets.length} hoja(s), ${r.unassigned.length} sin asignar`,
        );
        if (
          this.autoConfirm.avisarSinHojaPosible(
            distributorId,
            planDate,
            r.unassigned,
            ahora,
          )
        ) {
          noVehiclesAlerts += 1;
        }
      } catch (error) {
        registrarErrorAtrapado(error);
        this.logger.error(
          `Hoja de ruta ${distributorId} ${planDate}: falló la propuesta: ${errorMessage(error)}`,
        );
      }
    }
    return { proposed, noVehiclesAlerts };
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
