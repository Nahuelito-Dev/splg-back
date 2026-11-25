import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { RoleType } from '../../common/constants/role-type.enum';
import { errorMessage } from '../../common/errors/error-message';
import { Delivery } from '../../delivery/entities/delivery.entity';
import { HOJA_DE_RUTA_ENCENDIDA_POR_OMISION } from '../../distributor/process-config';
import { DeliveryService } from '../../delivery/delivery.service';
import { OrderStatus } from '../../order/entities/order.entity';
import { RouteBatch } from '../../order/entities/route-batch.entity';
import {
  RouteBatchStop,
  RouteStopRemovedReason,
} from '../../order/entities/route-batch-stop.entity';
import { OrderService } from '../../order/order.service';
import { RouteBatchKind, RouteBatchStatus } from '../domain/route-batch.enums';
import {
  HORIZONTE_DE_REPROGRAMACION,
  PlanificacionDelDia,
  diaHabilSiguiente,
  diasDeReprogramacion,
} from '../domain/route-sheet-execution';
import { idCortoDePedido } from '../../common/events/aviso-al-admin';
import { versionVigente } from '../domain/route-sheet-rules';
import { RoutePlanningCalendarService } from './route-planning-calendar.service';
import { RouteSheetEtaService } from './route-sheet-eta.service';
import { RouteSheetLocks } from './route-sheet-locks.service';
import {
  FranjaEstimada,
  MotivoDeCambio,
  RouteSheetNotifier,
  diaLegible,
} from './route-sheet-notifier.service';
import {
  CalculoEnCurso,
  ParadaEnCurso,
  RouteSheetProgress,
} from './route-sheet-progress.service';
import {
  hojaNoEncontrada,
  hojaNoEnCurso,
  paradaNoEncontrada,
  versionVieja,
} from './route-sheet.exceptions';

/** El recálculo de la hoja en curso y, si hubo un postergado, su franja nueva. */
export type RecalculoEnCurso = CalculoEnCurso & {
  postergado: FranjaEstimada | null;
};

/**
 * Cómo se reprograma un pedido que salió de la hoja (ver
 * `RouteSheetInProgress.reprogramar`), calculado antes de escribir.
 */
export interface PlanDeReprogramacion {
  /** El día nuevo; `null`: queda esperando al admin con la fecha que tenía. */
  fecha: string | null;
  /** Los días que sirven, en orden (el primero es `fecha`): la nueva visita (C5) busca cupo en ellos. */
  dias: string[];
  /** La parada queda esperando al admin (`needs_reschedule`). */
  esperaAlAdmin: boolean;
  causa: 'planificacion' | 'sin_dia' | 'apagada' | 'sin_franjas' | 'error';
}

/** Quién opera la parada: el chofer de la hoja o un admin. */
export interface QuienOpera {
  userId: string;
  esChofer: boolean;
}

/**
 * Piezas comunes de la hoja en curso (F34 E4) que usan el avance del chofer y
 * la edición del admin: la hoja en curso (o 404 / 409), el chofer de la hoja,
 * sacar una parada liberando su pedido, recalcular la cola y avisar.
 */
@Injectable()
export class RouteSheetInProgress {
  private readonly logger = new Logger(RouteSheetInProgress.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(RouteBatch)
    private readonly sheets: Repository<RouteBatch>,
    private readonly locks: RouteSheetLocks,
    private readonly progress: RouteSheetProgress,
    private readonly orders: OrderService,
    private readonly deliveries: DeliveryService,
    private readonly eta: RouteSheetEtaService,
    private readonly notifier: RouteSheetNotifier,
    private readonly calendario: RoutePlanningCalendarService,
  ) {}

  /**
   * Saca la parada (motivo y nota) y libera el pedido por el camino único de
   * liberación. Si la liberación falla, la parada vuelve a la hoja (no queda un
   * pedido del chofer fuera de su hoja).
   */
  async sacarYLiberar(
    sheet: RouteBatch,
    orderId: string,
    quien: QuienOpera,
    salida: { motivo: RouteStopRemovedReason; nota: string | null },
    subirVersion = false,
  ): Promise<void> {
    await this.locks.enTransaccion(
      sheet.distributorId,
      [{ id: sheet.batchId }],
      async (manager, [fila]) => {
        await manager.update(
          RouteBatchStop,
          { batchId: fila.batchId, orderId, active: true },
          {
            active: false,
            removedReason: salida.motivo,
            removedAt: new Date(),
            removedNote: salida.nota,
          },
        );
        if (subirVersion) {
          fila.editedAt = new Date();
          await manager.save(fila);
        }
      },
    );
    try {
      await this.orders.updateStatus(
        orderId,
        OrderStatus.PENDING,
        quien.esChofer ? quien.userId : undefined,
        quien.esChofer ? RoleType.DELIVERY : RoleType.ADMIN,
        quien.userId,
      );
    } catch (error) {
      await this.dataSource.manager.update(
        RouteBatchStop,
        { batchId: sheet.batchId, orderId },
        {
          active: true,
          removedReason: null,
          removedAt: null,
          removedNote: null,
        },
      );
      throw error;
    }
  }

  /**
   * Reprograma solo un pedido que ya salió de la hoja y se liberó (segundo
   * intento fallido o cierre a mano), SIN franja fija (la hora la calcula el
   * planificador de ese día; al cliente se le avisa cuando se confirme la hoja).
   * Días hábiles de la distribuidora: `workingDays` menos sus feriados.
   *  - con la hoja de ruta encendida, para el PRIMER día hábil cuya
   *    planificación siga abierta (entra en la propuesta de ese día; la retención
   *    de la planificación lo cubre hasta el cierre);
   *  - si no hay ninguno en `HORIZONTE_DE_REPROGRAMACION` días, no se le
   *    cambia la fecha y queda esperando al admin;
   *  - apagada, o sin franjas activas (sin jornada no sería planificable), para
   *    el día hábil siguiente, y queda esperando al admin (`needs_reschedule`):
   *    nadie lo despacha solo.
   * Avisa al cliente (push) y al admin (bandeja). Si no se puede (se canceló o se
   * asignó en el medio), la parada queda esperando al admin. Devuelve la fecha
   * nueva, o `null`.
   */
  async reprogramar(
    sheet: RouteBatch,
    orderId: string,
    { avisarAlCliente = true }: { avisarAlCliente?: boolean } = {},
  ): Promise<string | null> {
    const plan = await this.planDeReprogramacion(sheet, orderId);
    try {
      if (plan.fecha) {
        const order = await this.orders.reprogramarEntrega(orderId, plan.fecha);
        if (avisarAlCliente) {
          await this.notifier
            .reprogramadoAlCliente(
              order.customerId,
              orderId,
              plan.fecha,
              sheet.distributorId,
            )
            .catch(() => undefined);
        }
      }
      if (plan.esperaAlAdmin) await this.esperarAlAdmin(sheet, orderId);
    } catch (error) {
      this.logger.warn(
        `Hoja ${sheet.batchId}: no se pudo reprogramar el pedido ${orderId}: ${errorMessage(error)}`,
      );
      const fallida: PlanDeReprogramacion = {
        fecha: null,
        dias: [],
        esperaAlAdmin: true,
        causa: 'error',
      };
      await this.esperarAlAdmin(sheet, orderId);
      this.avisarReprogramacion(sheet, orderId, fallida, null);
      return null;
    }
    this.avisarReprogramacion(sheet, orderId, plan, plan.fecha);
    return plan.fecha;
  }

  /**
   * El día al que se reprograma (ver [reprogramar]), sin escribir nada: con la
   * planificación encendida, los días con la planificación abierta (`dias`, el
   * primero es `fecha`); apagada o sin jornada, el día hábil siguiente (y los
   * hábiles que siguen), esperando al admin. Si no se puede calcular, espera al
   * admin (`causa: error`).
   */
  async planDeReprogramacion(
    sheet: RouteBatch,
    orderId: string,
  ): Promise<PlanDeReprogramacion> {
    const planDate = sheet.planDate as string;
    try {
      const encendida = await this.planificacionEncendida(sheet.distributorId);
      const conJornada = await this.tieneJornada(sheet.distributorId);
      const cal = await this.calendario.calendario(
        sheet.distributorId,
        planDate,
      );
      if (encendida && conJornada) {
        const dias = diasDeReprogramacion(
          planDate,
          await this.planesSiguientes(sheet),
          Date.now(),
          cal,
        );
        // Ningún día con la planificación abierta en el horizonte: no se le
        // inventa una fecha; espera al admin con la fecha que tenía.
        if (dias.length === 0) {
          return { fecha: null, dias, esperaAlAdmin: true, causa: 'sin_dia' };
        }
        return {
          fecha: dias[0],
          dias,
          esperaAlAdmin: false,
          causa: 'planificacion',
        };
      }
      // Apagada, o sin franjas activas (sin jornada el planificador no lo
      // tomaría): el día hábil siguiente y queda esperando al admin, retenido
      // del despacho y del pool (`needs_reschedule` espera sin importar la fecha).
      const fecha = diaHabilSiguiente(planDate, cal);
      return {
        fecha,
        dias: [fecha, ...diasDeReprogramacion(fecha, new Map(), 0, cal)],
        esperaAlAdmin: true,
        causa: encendida ? 'sin_franjas' : 'apagada',
      };
    } catch (error) {
      this.logger.warn(
        `Hoja ${sheet.batchId}: no se pudo calcular la reprogramación del pedido ${orderId}: ${errorMessage(error)}`,
      );
      return { fecha: null, dias: [], esperaAlAdmin: true, causa: 'error' };
    }
  }

  /**
   * La reprogramación dentro de la transacción de quien llama (la salida de la
   * hoja y la visita fallida, C5): revalida el plan (ver [revalidar]), deja la
   * fecha nueva del pedido y, si corresponde, la parada esperando al admin.
   * Devuelve el plan que quedó. Un error sube y deshace todo.
   */
  async aplicarReprogramacion(
    manager: EntityManager,
    sheet: RouteBatch,
    orderId: string,
    plan: PlanDeReprogramacion,
  ): Promise<PlanDeReprogramacion> {
    const vigente = await this.revalidar(manager, sheet, plan);
    if (vigente.fecha) {
      await this.orders.reprogramarEntrega(orderId, vigente.fecha, manager);
    }
    if (vigente.esperaAlAdmin) {
      await this.esperarAlAdmin(sheet, orderId, manager);
    }
    return vigente;
  }

  /**
   * El plan se calculó fuera de la transacción: con la planificación encendida,
   * se vuelven a leer las planificaciones de esos días con sus filas bloqueadas
   * (`FOR SHARE`: un cierre o una propuesta espera a que esto confirme) y se
   * descartan los días que dejaron de estar abiertos. Si no queda ninguno,
   * espera al admin (`sin_dia`).
   */
  private async revalidar(
    manager: EntityManager,
    sheet: RouteBatch,
    plan: PlanDeReprogramacion,
  ): Promise<PlanDeReprogramacion> {
    if (plan.causa !== 'planificacion' || plan.dias.length === 0) return plan;
    const filas: Array<{ fecha: string; status: string; cutoffAt: Date }> =
      await manager.query(
        `SELECT to_char("plan_date", 'YYYY-MM-DD') AS "fecha", "status"::text AS "status", "cutoff_at" AS "cutoffAt"
           FROM "route_plan"
          WHERE "distributor_id" = $1 AND "plan_date" = ANY($2::date[])
          FOR SHARE`,
        [sheet.distributorId, plan.dias],
      );
    const ahora = Date.now();
    const cerrados = new Set(
      filas
        .filter(
          (f) =>
            !(f.status === 'open' && new Date(f.cutoffAt).getTime() > ahora),
        )
        .map((f) => f.fecha),
    );
    const dias = plan.dias.filter((d) => !cerrados.has(d));
    if (dias.length === 0) {
      return { fecha: null, dias: [], esperaAlAdmin: true, causa: 'sin_dia' };
    }
    return { ...plan, fecha: dias[0], dias };
  }

  /**
   * La bandeja del admin después de reprogramar (ya confirmado). `fecha`: el día
   * en que quedó el pedido (la nueva visita puede haberlo corrido a otro con
   * cupo).
   */
  avisarReprogramacion(
    sheet: RouteBatch,
    orderId: string,
    plan: PlanDeReprogramacion,
    fecha: string | null,
  ): void {
    const corto = idCortoDePedido(orderId);
    if (plan.causa === 'error') {
      this.notifier.aLaBandeja(sheet.distributorId, {
        kind: 'route_sheet_reschedule_failed',
        title: 'Pedido no entregado: decidí qué hacer',
        body: `El pedido ${corto} no se pudo entregar y no se pudo reprogramar solo: reprogramalo o cancelalo.`,
        dedupeKey: `route-sheet-reschedule-failed:${sheet.batchId}:${orderId}`,
      });
      return;
    }
    if (plan.causa === 'sin_dia' || !fecha) {
      this.notifier.aLaBandeja(sheet.distributorId, {
        kind: 'route_sheet_reschedule_needs_admin',
        title: 'Pedido no entregado: reprogramalo vos',
        body: `El pedido ${corto} no se pudo entregar y no hay un día con la hoja de ruta abierta en los próximos ${HORIZONTE_DE_REPROGRAMACION} días: reprogramalo, asignalo o cancelalo (no lo toma el despacho solo).`,
        dedupeKey: `route-sheet-rescheduled:${sheet.batchId}:${orderId}`,
      });
      return;
    }
    if (plan.causa === 'planificacion') {
      this.notifier.aLaBandeja(sheet.distributorId, {
        kind: 'route_sheet_order_rescheduled',
        title: 'Pedido reprogramado',
        body: `El pedido ${corto} no se pudo entregar y se reprogramó solo para el ${diaLegible(fecha)}: entra en la hoja de ruta de ese día. Si hace falta, cambiale la fecha o cancelalo.`,
        dedupeKey: `route-sheet-rescheduled:${sheet.batchId}:${orderId}`,
      });
      return;
    }
    this.notifier.aLaBandeja(sheet.distributorId, {
      kind: 'route_sheet_reschedule_needs_admin',
      title: 'Pedido reprogramado: asignalo vos',
      body: `El pedido ${corto} no se pudo entregar y se reprogramó para el ${diaLegible(fecha)}, pero ${plan.causa === 'sin_franjas' ? 'la distribuidora no tiene franjas horarias activas' : 'la hoja de ruta está apagada'}: asignalo, agregalo a una hoja o cancelalo (no lo toma el despacho solo).`,
      dedupeKey: `route-sheet-rescheduled:${sheet.batchId}:${orderId}`,
    });
  }

  /** La parada que salió queda esperando al admin (`needs_reschedule`). */
  private async esperarAlAdmin(
    sheet: RouteBatch,
    orderId: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<void> {
    await manager.update(
      RouteBatchStop,
      { batchId: sheet.batchId, orderId, active: false },
      { removedReason: RouteStopRemovedReason.NEEDS_RESCHEDULE },
    );
  }

  /** La distribuidora tiene franjas activas: hay jornada para planificar un pedido sin franja. */
  private async tieneJornada(distributorId: string): Promise<boolean> {
    const [f]: Array<{ hay: boolean }> = await this.dataSource.query(
      `SELECT EXISTS (SELECT 1 FROM "time_slot" WHERE "distributor_id" = $1 AND "isActive") AS "hay"`,
      [distributorId],
    );
    return f?.hay === true;
  }

  private async planificacionEncendida(
    distributorId: string,
  ): Promise<boolean> {
    // Sin fila de parámetros, o sin `enabled` guardado, viene encendida.
    const [f]: Array<{ enabled: number }> = await this.dataSource.query(
      `SELECT COALESCE(("params" ->> 'enabled')::int, ${HOJA_DE_RUTA_ENCENDIDA_POR_OMISION}) AS "enabled" FROM "module_config"
        WHERE "distributor_id" = $1 AND "module"::text = 'route_planning'`,
      [distributorId],
    );
    return Number(f?.enabled ?? HOJA_DE_RUTA_ENCENDIDA_POR_OMISION) === 1;
  }

  /** Las planificaciones de los días siguientes a la hoja (para elegir el primero abierto). */
  private async planesSiguientes(
    sheet: RouteBatch,
  ): Promise<Map<string, PlanificacionDelDia>> {
    const filas: Array<{ fecha: string; status: string; cutoffAt: Date }> =
      await this.dataSource.query(
        `SELECT to_char("plan_date", 'YYYY-MM-DD') AS "fecha", "status"::text AS "status", "cutoff_at" AS "cutoffAt"
           FROM "route_plan"
          WHERE "distributor_id" = $1 AND "plan_date" > $2::date AND "plan_date" <= $2::date + $3::int`,
        [sheet.distributorId, sheet.planDate, HORIZONTE_DE_REPROGRAMACION],
      );
    return new Map(
      filas.map((f) => [
        f.fecha,
        { status: f.status, cutoffMs: new Date(f.cutoffAt).getTime() },
      ]),
    );
  }

  /**
   * Recalcula la cola de la hoja en curso desde la posición actual (re-optimiza
   * si `reordenar`) y avisa. `postergado`: el pedido que no se pudo entregar en
   * el primer intento (ver `RouteSheetEtaService.avisar`); su franja nueva
   * vuelve en `postergado`.
   */
  async rehacer(
    distributorId: string,
    id: string,
    driverUserId: string | null,
    o: { reordenar: boolean; postergado?: string },
  ): Promise<RecalculoEnCurso | null> {
    const nowMs = Date.now();
    const posicion = driverUserId
      ? await this.progress.posicionDelChofer(driverUserId, nowMs)
      : null;
    const calculo = await this.locks.enTransaccion(
      distributorId,
      [{ id }],
      (manager, [fila]) =>
        fila.status === RouteBatchStatus.ASSIGNED
          ? this.progress.rehacer(manager, fila, {
              reordenar: o.reordenar,
              nowMs,
              posicion,
            })
          : Promise.resolve(null),
    );
    if (!calculo) return null;
    const postergado = await this.eta
      .avisar(distributorId, id, calculo, nowMs, driverUserId, {
        postergado: o.postergado,
      })
      .catch((e: unknown) => {
        this.logger.warn(`Hoja ${id}: avisos: ${errorMessage(e)}`);
        return null;
      });
    return { ...calculo, postergado };
  }

  async trasCambio(
    distributorId: string,
    id: string,
    calculo: CalculoEnCurso,
    chofer: Delivery | null,
  ): Promise<void> {
    await this.eta
      .avisar(distributorId, id, calculo, Date.now(), chofer?.userId ?? null)
      .catch((e: unknown) =>
        this.logger.warn(`Hoja ${id}: avisos: ${errorMessage(e)}`),
      );
    this.notifier.alPanel(distributorId, 'route-sheet:updated', {
      sheetId: id,
      status: RouteBatchStatus.ASSIGNED,
    });
  }

  /** Aviso al chofer de que la hoja en curso cambió (socket y push). */
  avisarCambio(
    chofer: Delivery,
    id: string,
    motivo: MotivoDeCambio,
    extra: Record<string, unknown>,
  ): void {
    this.notifier.alChofer(chofer.userId, 'route-sheet:changed', {
      sheetId: id,
      reason: motivo,
      ...extra,
    });
    const textos: Record<MotivoDeCambio, string> = {
      stop_added: 'Se agregó una parada a tu hoja.',
      stop_removed: 'Una parada salió de tu hoja.',
      stop_failed: 'Una parada se marcó como no entregada.',
      reordered: 'Se reordenaron las paradas que te faltan.',
    };
    void this.notifier.pushAlChofer(
      { distributorId: chofer.distributorId, driverUserId: chofer.userId },
      chofer.notificationToken,
      id,
      textos[motivo],
    );
  }

  async enCurso(
    distributorId: string,
    id: string,
    version?: number,
  ): Promise<RouteBatch> {
    const sheet = await this.sheets.findOne({
      where: { batchId: id, distributorId, kind: RouteBatchKind.PLANNED },
    });
    if (!sheet) throw hojaNoEncontrada();
    if (sheet.status !== RouteBatchStatus.ASSIGNED) throw hojaNoEnCurso();
    // La misma regla que la edición del borrador: 409 si la versión quedó vieja.
    if (version !== undefined && !versionVigente(sheet.version, version)) {
      throw versionVieja();
    }
    return sheet;
  }

  parada(paradas: ParadaEnCurso[], orderId: string): ParadaEnCurso {
    const p = paradas.find((x) => x.stop.orderId === orderId);
    if (!p) throw paradaNoEncontrada();
    return p;
  }

  /** El chofer de la hoja; otro chofer (o una hoja de otra distribuidora) es 404. */
  async choferDeLaHoja(
    distributorId: string,
    id: string,
    userId: string,
  ): Promise<Delivery> {
    const d = await this.deliveries.findOneByUserId(userId).catch(() => null);
    const sheet = await this.sheets.findOne({
      where: { batchId: id, distributorId, kind: RouteBatchKind.PLANNED },
    });
    if (!d || !sheet || d.distributorId !== distributorId) {
      throw hojaNoEncontrada();
    }
    if (sheet.deliveryId !== d.deliveryId) throw hojaNoEncontrada();
    return d;
  }

  async choferDe(
    sheet: Pick<RouteBatch, 'deliveryId'>,
  ): Promise<Delivery | null> {
    return sheet.deliveryId ? this.deliveries.findById(sheet.deliveryId) : null;
  }

  async otroEnCaminoDelChofer(
    deliveryId: string,
    orderId: string,
  ): Promise<boolean> {
    const filas: unknown[] = await this.dataSource.query(
      `SELECT 1 FROM "order" WHERE "delivery_id" = $1 AND "status"::text = 'on_the_way' AND "order_id" <> $2 LIMIT 1`,
      [deliveryId, orderId],
    );
    return filas.length > 0;
  }
}
