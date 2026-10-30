import { Injectable } from '@nestjs/common';
import { EntityManager, In, Not } from 'typeorm';
import { diaArgentino } from '../common/utils/dias-argentina';
import { normalizarFechaCalendario } from './domain/fleet-lock.util';
import {
  MaintenanceDocumentKind,
  MaintenancePlan,
  MaintenanceSubject,
} from './entities/maintenance-plan.entity';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from './entities/maintenance-task.entity';

export interface PolizaParaLaFlota {
  distributorId: string;
  carId: string;
  /** Tipo del vehículo: un plan puede aplicar sólo a un tipo. */
  typeCar: string | null;
  /** `YYYY-MM-DD` */
  validFrom: string;
  /** `YYYY-MM-DD` */
  validTo: string;
  /** Prima total de la póliza (suma de sus cuotas). */
  cost: number;
  insurerName: string;
  policyNumber: string;
}

/** Una tarea que la póliza dio por hecha, con el estado en que estaba para poder reabrirla. */
export interface TareaCerrada {
  taskId: string;
  status: MaintenanceTaskStatus;
}

export interface ResultadoDeLaSincronizacion {
  synced: boolean;
  /** La póliza empieza después de que vence el seguro actual: se sincroniza cuando empiece. */
  pending: boolean;
  /** La tarea creada por esta póliza (o la que ya cubría, si no se sincronizó). */
  taskId: string | null;
  /** Las tareas que la póliza dio por hechas. */
  closedTasks: TareaCerrada[];
  reason: string | null;
}

export interface ResultadoDeLaReversion {
  reverted: boolean;
  /** Lo que no se pudo revertir porque alguien lo cambió, o por qué no. */
  notes: string[];
}

export interface TareasDeLaPoliza {
  distributorId: string;
  /** La tarea que creó la póliza. */
  taskId: string | null;
  closedTasks: TareaCerrada[];
  /** Lo que la póliza dejó en la tarea: si ya no coincide, alguien la cambió. */
  validTo: string;
}

const ESTADOS_CERRADOS = [
  MaintenanceTaskStatus.DONE,
  MaintenanceTaskStatus.CANCELLED,
];

/**
 * El seguro de un vehículo es un documento de los planes de flota: una tarea
 * con vencimiento, y un seguro vencido bloquea el despacho. Cuando se da de
 * alta o se renueva una póliza, esta tarea la deja con el vencimiento de la
 * póliza nueva y cierra la anterior, en la transacción de quien llama.
 *
 * No inventa nada: si la distribuidora no tiene un plan de seguro activo para
 * el vehículo, o la póliza no vence después de lo que ya está cargado (una
 * póliza vieja que se registra para el historial), no toca la flota y lo dice.
 */
@Injectable()
export class FleetInsuranceSyncService {
  async sincronizar(
    manager: EntityManager,
    poliza: PolizaParaLaFlota,
    hoy: string = diaArgentino(),
  ): Promise<ResultadoDeLaSincronizacion> {
    const noSincroniza = (
      reason: string,
      taskId: string | null = null,
      pending = false,
    ): ResultadoDeLaSincronizacion => ({
      synced: false,
      pending,
      taskId,
      closedTasks: [],
      reason,
    });
    if (poliza.validTo <= hoy) {
      return noSincroniza(
        'La póliza ya venció: se registra como historial y no toca la flota',
      );
    }
    const plan = await this.planDeSeguro(manager, poliza);
    if (!plan) {
      return noSincroniza(
        'La distribuidora no tiene un plan de seguro activo para este vehículo en la flota',
      );
    }

    const vencimiento = normalizarFechaCalendario(
      new Date(`${poliza.validTo}T00:00:00.000Z`),
    );
    const abiertas = await manager.getRepository(MaintenanceTask).find({
      where: {
        distributorId: poliza.distributorId,
        carId: poliza.carId,
        planId: plan.planId,
        status: Not(In(ESTADOS_CERRADOS)),
      },
      lock: { mode: 'pessimistic_write' },
    });
    const yaVigente = abiertas.find(
      (t) => t.dueAt !== null && t.dueAt.getTime() >= vencimiento.getTime(),
    );
    if (yaVigente) {
      return noSincroniza(
        'La tarea de seguro del vehículo ya vence en la misma fecha o después',
        yaVigente.taskId,
      );
    }
    // Una póliza reemplaza a la vigente sólo si empieza antes de que ésta
    // venza: con un hueco, la tarea actual sigue (que venza y bloquee es lo
    // correcto) y la sincronización queda para el día en que la póliza empiece.
    const vencimientos = abiertas.flatMap((t) => (t.dueAt ? [t.dueAt] : []));
    const ultimoVencimiento = vencimientos.length
      ? Math.max(...vencimientos.map((d) => d.getTime()))
      : null;
    if (
      ultimoVencimiento !== null &&
      poliza.validFrom > hoy &&
      normalizarFechaCalendario(
        new Date(`${poliza.validFrom}T00:00:00.000Z`),
      ).getTime() > ultimoVencimiento
    ) {
      return noSincroniza(
        'La póliza empieza después de que vence el seguro actual: la tarea se actualiza cuando empiece',
        null,
        true,
      );
    }

    const ahora = new Date();
    const cerradas: TareaCerrada[] = abiertas.map((t) => ({
      taskId: t.taskId,
      status: t.status,
    }));
    for (const tarea of abiertas) {
      tarea.status = MaintenanceTaskStatus.DONE;
      tarea.performedAt = ahora;
      await manager.save(tarea);
    }

    const nueva = await manager.save(
      manager.create(MaintenanceTask, {
        planId: plan.planId,
        distributorId: poliza.distributorId,
        carId: poliza.carId,
        deliveryId: null,
        employeeId: null,
        status: MaintenanceTaskStatus.SCHEDULED,
        dueAt: vencimiento,
        validFrom: normalizarFechaCalendario(
          new Date(`${poliza.validFrom}T00:00:00.000Z`),
        ),
        cost: poliza.cost,
        provider: poliza.insurerName.slice(0, 120),
        referenceNumber: poliza.policyNumber.slice(0, 60),
        notes: null,
        details: null,
      }),
    );
    return {
      synced: true,
      pending: false,
      taskId: nueva.taskId,
      closedTasks: cerradas,
      reason: null,
    };
  }

  /**
   * Deshace lo que hizo `sincronizar` al cancelarse la póliza: cancela la tarea
   * que creó y reabre las que dio por hechas, con su estado y su vencimiento de
   * antes. Una tarea que alguien cambió mientras tanto no se pisa y se informa;
   * si la creada no se puede cancelar, tampoco se reabren las anteriores (se
   * abrirían dos seguros a la vez).
   */
  async revertir(
    manager: EntityManager,
    tareas: TareasDeLaPoliza,
  ): Promise<ResultadoDeLaReversion> {
    const repo = manager.getRepository(MaintenanceTask);
    const notes: string[] = [];
    if (tareas.taskId) {
      const creada = await repo.findOne({
        where: { taskId: tareas.taskId, distributorId: tareas.distributorId },
        lock: { mode: 'pessimistic_write' },
      });
      const intacta =
        creada !== null &&
        creada.status === MaintenanceTaskStatus.SCHEDULED &&
        creada.dueAt?.toISOString().slice(0, 10) === tareas.validTo &&
        creada.notes === null;
      if (!creada || !intacta) {
        return {
          reverted: false,
          notes: [
            'La tarea de seguro que creó la póliza ya cambió (se editó, se cerró o se canceló): no se tocó la flota',
          ],
        };
      }
      creada.status = MaintenanceTaskStatus.CANCELLED;
      await manager.save(creada);
    }
    for (const previa of tareas.closedTasks) {
      const tarea = await repo.findOne({
        where: { taskId: previa.taskId, distributorId: tareas.distributorId },
        lock: { mode: 'pessimistic_write' },
      });
      if (tarea?.cashMovementId) {
        notes.push(
          `La tarea anterior ${previa.taskId} ya tiene un pago registrado: no se reabrió`,
        );
        continue;
      }
      if (!tarea || tarea.status !== MaintenanceTaskStatus.DONE) {
        notes.push(
          `La tarea anterior ${previa.taskId} ya cambió: no se reabrió`,
        );
        continue;
      }
      tarea.status = previa.status;
      tarea.performedAt = null;
      await manager.save(tarea);
    }
    return { reverted: true, notes };
  }

  /** El plan de seguro activo del vehículo: el de su tipo si lo hay, si no el que aplica a todos. */
  private async planDeSeguro(
    manager: EntityManager,
    poliza: PolizaParaLaFlota,
  ): Promise<MaintenancePlan | null> {
    const planes = await manager.getRepository(MaintenancePlan).find({
      where: {
        distributorId: poliza.distributorId,
        subject: MaintenanceSubject.VEHICLE,
        documentKind: MaintenanceDocumentKind.INSURANCE,
        isActive: true,
      },
      order: { planId: 'ASC' },
    });
    const tipo = poliza.typeCar?.trim().toLowerCase() ?? null;
    return (
      planes.find(
        (p) => p.carType !== null && p.carType.trim().toLowerCase() === tipo,
      ) ??
      planes.find((p) => p.carType === null) ??
      null
    );
  }
}
