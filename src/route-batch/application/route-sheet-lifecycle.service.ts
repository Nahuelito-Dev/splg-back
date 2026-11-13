import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
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
 * `dissolved`). Confirmar NO asigna los pedidos (ADR-03): siguen pendientes y
 * retenidos por la hoja hasta que el chofer la inicie (E4).
 */
@Injectable()
export class RouteSheetLifecycleService {
  constructor(
    private readonly locks: RouteSheetLocks,
    private readonly writer: RouteSheetWriter,
    private readonly data: RouteSheetDataService,
    private readonly sequence: DocumentSequenceService,
  ) {}

  async confirmar(
    distributorId: string,
    id: string,
    body: { version: number; acceptLateStops?: boolean },
    userId: string,
  ): Promise<void> {
    const params = await this.writer.parametros(distributorId);
    await this.locks.conHojas(
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
      },
    );
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
      ? await this.data.choferes(distributorId(sheet), [sheet.deliveryId])
      : [];
    const [vehiculo] = sheet.carId
      ? await this.data.vehiculos(distributorId(sheet), [sheet.carId])
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
  ): Promise<void> {
    await this.locks.conHojas(
      distributorId,
      [{ id, version }],
      async (manager, [sheet]) => {
        if (sheet.status !== RouteBatchStatus.CONFIRMED)
          throw hojaNoReabrible();
        await this.assertDiaAbierto(manager, sheet);
        assertTransition(sheet.kind, sheet.status, RouteBatchStatus.DRAFT);
        sheet.status = RouteBatchStatus.DRAFT;
        sheet.confirmedAt = null;
        sheet.confirmedByUserId = null;
        sheet.editedAt = new Date();
        await manager.save(sheet);
        await manager.update(
          RouteBatchStop,
          { batchId: sheet.batchId, active: true },
          { plannedEtaAt: null },
        );
      },
    );
  }

  /** Cancela la hoja: las paradas salen y los pedidos vuelven al despacho del día. */
  async cancelar(
    distributorId: string,
    id: string,
    version: number,
  ): Promise<void> {
    await this.locks.conHojas(
      distributorId,
      [{ id, version }],
      async (manager, [sheet]) => {
        if (!esCancelable(sheet.status)) throw hojaNoCancelable();
        assertTransition(sheet.kind, sheet.status, RouteBatchStatus.DISSOLVED);
        await this.writer.apagarTodas(
          manager,
          sheet.batchId,
          RouteStopRemovedReason.ADMIN,
        );
        sheet.status = RouteBatchStatus.DISSOLVED;
        sheet.closeReason = RouteBatchCloseReason.ADMIN;
        sheet.closedAt = new Date();
        await manager.save(sheet);
      },
    );
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
