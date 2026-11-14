import { HttpException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  In,
  LessThanOrEqual,
  Repository,
} from 'typeorm';
import { diaArgentino } from '../../common/utils/dias-argentina';
import { ConfigurableProcess } from '../../distributor/entities/module-config.entity';
import { ProcessConfigService } from '../../distributor/process-config.service';
import {
  RouteBatch,
  RouteBatchCloseReason,
} from '../../order/entities/route-batch.entity';
import {
  RoutePlan,
  RoutePlanStatus,
} from '../../order/entities/route-plan.entity';
import { RouteBatchKind, RouteBatchStatus } from '../domain/route-batch.enums';
import {
  RouteSheetViolation,
  cierreDeLaPlanificacion,
  diaSiguiente,
} from '../domain/route-sheet-rules';
import { assertTransition } from '../domain/route-sheet.machine';
import { esDiaHabil } from '../domain/calendario-laboral';
import { RoutePlanningCalendarService } from './route-planning-calendar.service';
import { RouteSheetLifecycleService } from './route-sheet-lifecycle.service';
import {
  fechaPasada,
  planCerrado,
  planNoEncontrado,
} from './route-sheet.exceptions';

export interface ResultadoConfirmarTodas {
  confirmed: string[];
  failed: Array<{
    sheetId: string;
    message: string;
    violations: RouteSheetViolation[];
  }>;
}

/**
 * La planificación de un día (ADR-02): abrirla, cerrarla, confirmar todas sus
 * hojas, y lo que necesita el cron (qué distribuidoras proponen, qué días se
 * cierran solos). La propuesta está en `RoutePlanProposalService`.
 */
@Injectable()
export class RoutePlanService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(RoutePlan) private readonly plans: Repository<RoutePlan>,
    private readonly processConfig: ProcessConfigService,
    private readonly lifecycle: RouteSheetLifecycleService,
    private readonly calendario: RoutePlanningCalendarService,
  ) {}

  /** Abre el día (idempotente). 409 si la fecha ya pasó. */
  async abrir(
    distributorId: string,
    planDate: string,
    hoy: string = diaArgentino(),
  ): Promise<RoutePlan> {
    const existente = await this.plans.findOne({
      where: { distributorId, planDate },
    });
    if (existente) return existente;
    if (planDate < hoy) throw fechaPasada();
    const v = await this.processConfig.obtener(
      distributorId,
      ConfigurableProcess.ROUTE_PLANNING,
    );
    await this.plans
      .createQueryBuilder()
      .insert()
      .into(RoutePlan)
      .values({
        distributorId,
        planDate,
        status: RoutePlanStatus.OPEN,
        cutoffAt: cierreDeLaPlanificacion(
          planDate,
          v.cutoffHour,
          v.cutoffMinute,
        ),
      })
      .orIgnore()
      .execute();
    return this.plans.findOneOrFail({ where: { distributorId, planDate } });
  }

  /** Para armar a mano: el día abierto (lo abre si hace falta) y no cerrado. */
  async abrirParaEditar(
    distributorId: string,
    planDate: string,
  ): Promise<RoutePlan> {
    const plan = await this.abrir(distributorId, planDate);
    if (plan.status === RoutePlanStatus.CLOSED) throw planCerrado();
    return plan;
  }

  /**
   * Corre `fn` en una transacción con el día bloqueado para compartir: el cierre
   * (que lo bloquea para escribir) no se cruza con un alta.
   */
  enElDia<T>(
    distributorId: string,
    planDate: string,
    fn: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      const plan = await manager.findOne(RoutePlan, {
        where: { distributorId, planDate },
        lock: { mode: 'pessimistic_read' },
      });
      if (!plan) throw planNoEncontrado();
      if (plan.status === RoutePlanStatus.CLOSED) throw planCerrado();
      return fn(manager);
    });
  }

  async buscar(distributorId: string, planDate: string): Promise<RoutePlan> {
    const plan = await this.plans.findOne({
      where: { distributorId, planDate },
    });
    if (!plan) throw planNoEncontrado();
    return plan;
  }

  /**
   * Cierra el día: los borradores que quedan se descartan (`day_closed`) y sus
   * pedidos vuelven al despacho del día. Las confirmadas siguen.
   */
  async cerrar(
    distributorId: string,
    planDate: string,
    userId: string | null,
  ): Promise<RoutePlan> {
    return this.dataSource.transaction(async (manager) => {
      const plan = await manager.findOne(RoutePlan, {
        where: { distributorId, planDate },
        lock: { mode: 'pessimistic_write' },
      });
      if (!plan) throw planNoEncontrado();
      if (plan.status === RoutePlanStatus.CLOSED) throw planCerrado();
      const borradores = await manager.find(RouteBatch, {
        where: {
          distributorId,
          planDate,
          kind: RouteBatchKind.PLANNED,
          status: RouteBatchStatus.DRAFT,
        },
        order: { batchId: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
      const ahora = new Date();
      for (const hoja of borradores) {
        assertTransition(hoja.kind, hoja.status, RouteBatchStatus.DISSOLVED);
        await manager.query(
          `UPDATE "route_batch_stop" SET "active" = false WHERE "batch_id" = $1 AND "active"`,
          [hoja.batchId],
        );
        hoja.status = RouteBatchStatus.DISSOLVED;
        hoja.closeReason = RouteBatchCloseReason.DAY_CLOSED;
        hoja.closedAt = ahora;
        await manager.save(hoja);
      }
      plan.status = RoutePlanStatus.CLOSED;
      plan.closedAt = ahora;
      plan.closedByUserId = userId;
      return manager.save(plan);
    });
  }

  /** Confirma todos los borradores válidos; devuelve los que no pudo, con el motivo. */
  async confirmarTodas(
    distributorId: string,
    planDate: string,
    userId: string,
  ): Promise<ResultadoConfirmarTodas> {
    await this.buscar(distributorId, planDate);
    const borradores = await this.dataSource.getRepository(RouteBatch).find({
      where: {
        distributorId,
        planDate,
        kind: RouteBatchKind.PLANNED,
        status: RouteBatchStatus.DRAFT,
      },
      order: { createdAt: 'ASC', batchId: 'ASC' },
    });
    const r: ResultadoConfirmarTodas = { confirmed: [], failed: [] };
    for (const hoja of borradores) {
      try {
        await this.lifecycle.confirmar(
          distributorId,
          hoja.batchId,
          { version: hoja.version },
          userId,
        );
        r.confirmed.push(hoja.batchId);
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        const cuerpo = error.getResponse() as {
          message?: unknown;
          violations?: RouteSheetViolation[];
        };
        r.failed.push({
          sheetId: hoja.batchId,
          message:
            typeof cuerpo.message === 'string' ? cuerpo.message : error.message,
          violations: cuerpo.violations ?? [],
        });
      }
    }
    return r;
  }

  /**
   * Distribuidoras con la hoja encendida y la propuesta automática cuyo cierre
   * de mañana ya pasó y todavía no tienen la propuesta (ni el día cerrado).
   * Mañana tiene que ser un día hábil de la distribuidora: un día que no
   * reparte (`workingDays`) o un feriado no lleva plan.
   */
  async paraProponer(
    ahora: Date,
  ): Promise<Array<{ distributorId: string; planDate: string }>> {
    const manana = diaSiguiente(diaArgentino(ahora));
    const filas: Array<{ distributorId: string }> = await this.dataSource.query(
      `SELECT mc."distributor_id" AS "distributorId" FROM "module_config" mc
        WHERE mc."module"::text = 'route_planning'
          AND COALESCE((mc."params" ->> 'enabled')::numeric, 0) = 1
          AND COALESCE((mc."params" ->> 'autoPropose')::numeric, 1) = 1
        ORDER BY 1`,
    );
    const resultado: Array<{ distributorId: string; planDate: string }> = [];
    for (const { distributorId } of filas) {
      const v = await this.processConfig.obtener(
        distributorId,
        ConfigurableProcess.ROUTE_PLANNING,
      );
      const cierre = cierreDeLaPlanificacion(
        manana,
        v.cutoffHour,
        v.cutoffMinute,
      );
      if (ahora < cierre) continue;
      // Un día que la distribuidora no reparte (workingDays) o feriado: sin plan.
      const cal = await this.calendario.calendario(
        distributorId,
        diaArgentino(ahora),
      );
      if (!esDiaHabil(manana, cal)) continue;
      const plan = await this.plans.findOne({
        where: { distributorId, planDate: manana },
      });
      if (plan && plan.status !== RoutePlanStatus.OPEN) continue;
      resultado.push({ distributorId, planDate: manana });
    }
    return resultado;
  }

  /** Red del cierre: los días de hoy o anteriores todavía abiertos se cierran solos (00:00). */
  async cerrarDiasVencidos(ahora: Date): Promise<number> {
    const abiertos = await this.plans.find({
      where: {
        status: In([RoutePlanStatus.OPEN, RoutePlanStatus.PROPOSED]),
        planDate: LessThanOrEqual(diaArgentino(ahora)),
      },
      order: { planDate: 'ASC', planId: 'ASC' },
    });
    let cerrados = 0;
    for (const plan of abiertos) {
      try {
        await this.cerrar(plan.distributorId, plan.planDate, null);
        cerrados += 1;
      } catch (error) {
        // Otro proceso lo cerró en el medio: no es un error.
        if (!(error instanceof HttpException)) throw error;
      }
    }
    return cerrados;
  }
}
