import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { errorMessage } from '../../common/errors/error-message';
import { diaArgentino } from '../../common/utils/dias-argentina';
import {
  DocumentSequenceService,
  DocType,
} from '../../document-sequence/document-sequence.service';
import {
  RouteBatch,
  RouteBatchCloseReason,
} from '../../order/entities/route-batch.entity';
import {
  RouteBatchStop,
  RouteStopRemovedReason,
} from '../../order/entities/route-batch-stop.entity';
import {
  RoutePlan,
  RoutePlanStatus,
} from '../../order/entities/route-plan.entity';
import { computeSchedule } from '../domain/eta';
import { loadPeaks } from '../domain/load-profile';
import { RouteBatchStatus } from '../domain/route-batch.enums';
import {
  RouteSheetViolation,
  esCancelable,
  paradasNoPlanificables,
  violacionesParaConfirmar,
} from '../domain/route-sheet-rules';
import { assertTransition } from '../domain/route-sheet.machine';
import { RouteSheetAssignmentService } from './route-sheet-assignment.service';
import { RouteSheetEtaService } from './route-sheet-eta.service';
import { RouteSheetDataService } from './route-sheet-data.service';
import { RouteSheetLocks } from './route-sheet-locks.service';
import { RouteSheetWriter } from './route-sheet-writer.service';
import {
  hojaNoCancelable,
  hojaNoEditable,
  hojaNoReabrible,
  noConfirmable,
  planCerrado,
} from './route-sheet.exceptions';

/**
 * Ciclo de vida de la hoja que decide el administrador (§5): confirmar
 * (`draft → confirmed`), reabrir (`confirmed → draft`) y cancelar (→
 * `dissolved`). La hoja confirmada es del chofer (rediseño del 14/11): si es
 * de hoy, sus pedidos le quedan asignados al confirmarla; si es de otro día,
 * quedan retenidos y se le asignan al empezar ese día (asignarlos la víspera lo
 * dejaría ocupado para el despacho del día anterior). Reabrir o cancelar antes
 * del viaje le libera lo asignado.
 */
@Injectable()
export class RouteSheetLifecycleService {
  private readonly logger = new Logger(RouteSheetLifecycleService.name);

  constructor(
    private readonly locks: RouteSheetLocks,
    private readonly writer: RouteSheetWriter,
    private readonly data: RouteSheetDataService,
    private readonly sequence: DocumentSequenceService,
    private readonly asignacion: RouteSheetAssignmentService,
    private readonly eta: RouteSheetEtaService,
  ) {}

  /**
   * `userId` nulo: la confirma el sistema (confirmación automática); la
   * auditoría de la base la asienta como «sistema».
   */
  async confirmar(
    distributorId: string,
    id: string,
    body: { version: number; acceptLateStops?: boolean },
    userId: string | null,
  ): Promise<void> {
    const params = await this.writer.parametros(distributorId);
    const planDate = await this.locks.conHojas(
      distributorId,
      [{ id, version: body.version }],
      async (manager, [sheet]) => {
        if (sheet.status !== RouteBatchStatus.DRAFT) throw hojaNoEditable();
        const violaciones = await this.violaciones(
          manager,
          sheet,
          body.acceptLateStops === true,
          params,
        );
        if (violaciones.length > 0) throw noConfirmable(violaciones);
        assertTransition(sheet.kind, sheet.status, RouteBatchStatus.CONFIRMED);
        sheet.number ??= await this.sequence.siguienteNumero(
          manager,
          distributorId,
          DocType.ROUTE_SHEET,
        );
        sheet.status = RouteBatchStatus.CONFIRMED;
        sheet.confirmedAt = new Date();
        sheet.confirmedByUserId = userId;
        await manager.save(sheet);
        // Lo prometido: la ETA de cada parada queda congelada al confirmar.
        await manager.query(
          `UPDATE "route_batch_stop" SET "planned_eta_at" = "eta_at"
            WHERE "batch_id" = $1 AND "active"`,
          [sheet.batchId],
        );
        return sheet.planDate;
      },
    );
    // Los pedidos sin franja fija (reprogramados por la hoja) se enteran ahora
    // de su horario: la hora prometida al confirmar.
    await this.eta
      .avisarHorarioSinFranja(distributorId, id)
      .catch((e: unknown) =>
        this.logger.warn(
          `Hoja ${id} confirmada, pero no se avisó el horario a los pedidos sin franja: ${errorMessage(e)}`,
        ),
      );
    // La hoja de hoy le queda asignada al chofer en el acto (fuera de la
    // transacción y del cerrojo de la confirmación: la asignación toma el suyo).
    if (planDate === diaArgentino()) {
      await this.asignacion
        .asignarHoja(distributorId, id, userId)
        .catch((e: unknown) =>
          this.logger.warn(
            `Hoja ${id} confirmada, pero no se pudo asignar: ${errorMessage(e)}`,
          ),
        );
    }
  }

  /** Lo que impide confirmar la hoja, con las horas y la carga recalculadas. */
  async violaciones(
    manager: EntityManager,
    sheet: RouteBatch,
    acceptLateStops: boolean,
    params: Awaited<ReturnType<RouteSheetWriter['parametros']>>,
  ): Promise<RouteSheetViolation[]> {
    const e = await this.writer.recalcular(manager, sheet, params);
    const sch = computeSchedule(e.escenario.stops, e.escenario.schedule);
    const picos = loadPeaks(
      e.escenario.stops.map((s) => s.id),
      e.escenario.loads,
    );
    const [chofer] = sheet.deliveryId
      ? await this.data.choferes(
          distributorId(sheet),
          [sheet.deliveryId],
          sheet.planDate as string,
        )
      : [];
    const [vehiculo] = sheet.carId
      ? await this.data.vehiculos(
          distributorId(sheet),
          [sheet.carId],
          sheet.planDate as string,
        )
      : [];
    const ocupados = await this.data.ocupadosDelDia(
      sheet.distributorId,
      sheet.planDate as string,
      sheet.batchId,
      manager,
    );
    return violacionesParaConfirmar({
      deliveryId: sheet.deliveryId,
      carId: sheet.carId,
      stopCount: e.escenario.stops.length,
      driverUnavailable: !chofer?.available,
      carUnavailable: !vehiculo?.available,
      driverTaken:
        !!sheet.deliveryId && ocupados.deliveryIds.has(sheet.deliveryId),
      carTaken: !!sheet.carId && ocupados.carIds.has(sheet.carId),
      peakKg: picos.peakKg,
      peakUnits: picos.peakUnits,
      capacityKg: vehiculo?.capacityKg ?? null,
      capacityUnits: vehiculo?.capacityUnits ?? null,
      lateOrderIds: sch.stops.filter((s) => s.late).map((s) => s.id),
      acceptLateStops,
      unplannableOrderIds: paradasNoPlanificables(
        e.orden,
        e.pedidos,
        sheet.planDate as string,
      ),
    });
  }

  async reabrir(
    distributorId: string,
    id: string,
    version: number,
    actorUserId: string,
  ): Promise<void> {
    const asignada = await this.locks.conHojas(
      distributorId,
      [{ id, version }],
      async (manager, [sheet]) => {
        if (sheet.status !== RouteBatchStatus.CONFIRMED)
          throw hojaNoReabrible();
        await this.assertDiaAbierto(manager, sheet);
        assertTransition(sheet.kind, sheet.status, RouteBatchStatus.DRAFT);
        const lo = await this.loAsignado(manager, sheet);
        sheet.status = RouteBatchStatus.DRAFT;
        sheet.confirmedAt = null;
        sheet.confirmedByUserId = null;
        sheet.assignedAt = null;
        sheet.editedAt = new Date();
        await manager.save(sheet);
        await manager.update(
          RouteBatchStop,
          { batchId: sheet.batchId, active: true },
          { plannedEtaAt: null },
        );
        return lo;
      },
    );
    // En borrador nadie lleva los pedidos: se le liberan al chofer y quedan
    // retenidos por la hoja (siguen siendo sus paradas).
    await this.asignacion.liberar(
      asignada.deliveryId,
      asignada.orderIds,
      actorUserId,
    );
  }

  /** Cancela la hoja: las paradas salen y los pedidos vuelven al despacho del día. */
  async cancelar(
    distributorId: string,
    id: string,
    version: number,
    actorUserId: string,
  ): Promise<void> {
    const asignada = await this.locks.conHojas(
      distributorId,
      [{ id, version }],
      async (manager, [sheet]) => {
        if (!esCancelable(sheet.status)) throw hojaNoCancelable();
        assertTransition(sheet.kind, sheet.status, RouteBatchStatus.DISSOLVED);
        const lo = await this.loAsignado(manager, sheet);
        await this.writer.apagarTodas(
          manager,
          sheet.batchId,
          RouteStopRemovedReason.ADMIN,
        );
        sheet.status = RouteBatchStatus.DISSOLVED;
        sheet.closeReason = RouteBatchCloseReason.ADMIN;
        sheet.closedAt = new Date();
        sheet.assignedAt = null;
        await manager.save(sheet);
        return lo;
      },
    );
    // Lo que ya se le había asignado al chofer (hoja de hoy) se le libera y
    // vuelve al despacho del día, como el resto de la hoja cancelada.
    await this.asignacion.liberar(
      asignada.deliveryId,
      asignada.orderIds,
      actorUserId,
    );
  }

  /** Los pedidos que la hoja le asignó a su chofer (para liberarlos al sacarle la hoja). */
  private async loAsignado(
    manager: EntityManager,
    sheet: RouteBatch,
  ): Promise<{ deliveryId: string | null; orderIds: string[] }> {
    if (!sheet.assignedAt) return { deliveryId: null, orderIds: [] };
    const paradas = await this.writer.paradasActivas(
      manager,
      sheet.batchId,
      false,
    );
    return {
      deliveryId: sheet.deliveryId,
      orderIds: paradas.map((p) => p.orderId),
    };
  }

  /** Una hoja no vuelve a borrador en un día cerrado (el cierre ya descartó los borradores). */
  private async assertDiaAbierto(
    manager: EntityManager,
    sheet: RouteBatch,
  ): Promise<void> {
    const plan = await manager.findOne(RoutePlan, {
      where: {
        distributorId: sheet.distributorId,
        planDate: sheet.planDate as string,
      },
    });
    if (plan?.status === RoutePlanStatus.CLOSED) throw planCerrado();
  }
}

const distributorId = (s: RouteBatch): string => s.distributorId;
