import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { errorMessage } from '../common/errors/error-message';
import { ZONA_ARGENTINA } from '../common/utils/dias-argentina';
import { ProcessName } from '../process-run/domain/process-catalog';
import { EmpresasParaProceso } from '../process-run/empresas-para-proceso';
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
import { ServiceTimeService } from './application/service-time.service';
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
  static readonly CERROJO_APRENDER = 'cron:route-planning:learn-service-time';
  static readonly CERROJO_TTL_MS = 10 * 60_000;

  private readonly logger = new Logger(RoutePlanningCron.name);

  constructor(
    private readonly plans: RoutePlanService,
    private readonly proposal: RoutePlanProposalService,
    private readonly redis: RedisService,
    private readonly watch: RouteSheetWatchService,
    private readonly autoConfirm: RoutePlanAutoConfirmService,
    private readonly empresas: EmpresasParaProceso,
    private readonly serviceTime: ServiceTimeService,
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

  /**
   * Tiempo de atención aprendido (M4): de madrugada, antes de la propuesta del
   * día siguiente, recalcula la mediana de «Llegué» a la entrega de cada
   * distribuidora con la hoja de ruta habilitada. Idempotente.
   */
  @Cron('0 15 3 * * *', { timeZone: ZONA_ARGENTINA })
  @ConRegistro(ProcessName.ROUTE_SERVICE_TIME_LEARN)
  aprenderTiempoDeAtencion(): Promise<{ companies: number } | undefined> {
    return this.conCerrojo(RoutePlanningCron.CERROJO_APRENDER, async () => {
      const r = await this.empresas.recorrer(
        {
          proceso: ProcessName.ROUTE_SERVICE_TIME_LEARN,
          modulo: 'route_planning',
        },
        (distributorId) => this.serviceTime.calcular(distributorId),
      );
      return { companies: r.empresas.length };
    });
  }

  /**
   * Propone mañana en las distribuidoras cuyo cierre pasó y que tienen la hoja
   * de ruta habilitada por la plataforma (módulo `route_planning`); una que
   * falla no frena a las demás. Con el módulo apagado no se planifica el día
   * siguiente; las hojas en curso se terminan (`seguir`, `cerrarDias`).
   */
  async proponerLasQueTocan(
    ahora: Date,
  ): Promise<{ proposed: number; noVehiclesAlerts: number }> {
    const fechas = new Map<string, string[]>();
    for (const { distributorId, planDate } of await this.plans.paraProponer(
      ahora,
    )) {
      fechas.set(distributorId, [
        ...(fechas.get(distributorId) ?? []),
        planDate,
      ]);
    }
    let proposed = 0;
    let noVehiclesAlerts = 0;
    await this.empresas.recorrer(
      {
        proceso: ProcessName.ROUTE_PLANNING_PROPOSE,
        modulo: 'route_planning',
        crea: true,
        entre: [...fechas.keys()],
      },
      async (distributorId, empresa) => {
        for (const planDate of fechas.get(distributorId) ?? []) {
          // Sin caché, justo antes de proponer cada día (§6.3).
          if (!(await empresa.sigueHabilitada())) return;
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
        }
      },
    );
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
