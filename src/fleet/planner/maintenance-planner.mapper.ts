import { PlanningCaseStatus } from '../entities/maintenance-planning-case.entity';
import { diasHasta } from './domain/ventanas-de-taller';
import { MaintenancePlanningCase } from '../entities/maintenance-planning-case.entity';
import {
  MaintenanceWindowProposal,
  WindowProposalStatus,
} from '../entities/maintenance-window-proposal.entity';
import { textoDeEscalamiento } from './maintenance-planner-notifier';
import { requiereTaller } from './maintenance-planner.service';
import type {
  CasoCompleto,
  VencimientosDeVehiculo,
} from './maintenance-planner.service';
import {
  DriverProposalResponseDto,
  ForecastVehicleResponseDto,
  PlanningCaseDetailResponseDto,
  PlanningCaseResponseDto,
  WindowProposalResponseDto,
} from './dto/planner-response.dto';

export class MaintenancePlannerMapper {
  static proposal(p: MaintenanceWindowProposal): WindowProposalResponseDto {
    return {
      proposalId: p.proposalId,
      caseId: p.caseId,
      taskId: p.taskId,
      windowStart: p.windowStart,
      windowEnd: p.windowEnd,
      rank: p.rank,
      status: p.status,
      expiresAt: p.expiresAt,
      respondedAt: p.respondedAt,
      rejectionReason: p.rejectionReason,
      altWindowStart: p.altWindowStart,
      altWindowEnd: p.altWindowEnd,
    };
  }

  static driverProposal(
    p: MaintenanceWindowProposal,
  ): DriverProposalResponseDto {
    return {
      ...MaintenancePlannerMapper.proposal(p),
      taskName: p.task.plan.name,
      carId: p.task.carId as string,
      patent: p.task.car?.carPatent ?? null,
      caseStatus: p.planningCase.status,
      urgent: p.windowEnd.getTime() > p.planningCase.projectedDueAt.getTime(),
      projectedDueAt: p.planningCase.projectedDueAt.toISOString(),
      ...MaintenancePlannerMapper.ventanaConfirmada(p.planningCase),
    };
  }

  /** La ventana que quedó confirmada en el caso, la elija el chofer o el administrador. */
  private static ventanaConfirmada(c: {
    status: PlanningCaseStatus;
    chosenStart: Date | null;
    chosenEnd: Date | null;
  }): { confirmedStart: string | null; confirmedEnd: string | null } {
    const confirmado =
      c.status === PlanningCaseStatus.CONFIRMED && c.chosenStart && c.chosenEnd;
    return {
      confirmedStart: confirmado ? c.chosenStart!.toISOString() : null,
      confirmedEnd: confirmado ? c.chosenEnd!.toISOString() : null,
    };
  }

  static caso(c: CasoCompleto): PlanningCaseResponseDto {
    const cerradas = c.proposals.filter(
      (p) => p.status !== WindowProposalStatus.PENDING,
    );
    const vigente = c.proposals.find(
      (p) => p.status === WindowProposalStatus.PENDING,
    );
    const ultima = cerradas.length > 0 ? cerradas[cerradas.length - 1] : null;
    const user = c.delivery?.user;
    return {
      caseId: c.caseId,
      status: c.status,
      taskId: c.taskId,
      taskName: c.task.plan.name,
      criticality: c.task.plan.criticality,
      carId: c.carId,
      patent: c.car.carPatent ?? null,
      deliveryId: c.deliveryId,
      driverName: user?.fullName ?? null,
      projectedDueAt: c.projectedDueAt,
      openedAt: c.openedAt,
      escalationReason: c.escalationReason,
      escalationText: c.escalationReason
        ? textoDeEscalamiento(c.escalationReason)
        : null,
      escalatedAt: c.escalatedAt,
      chosenStart: c.chosenStart,
      chosenEnd: c.chosenEnd,
      chosenSource: c.chosenSource,
      resolvedAt: c.resolvedAt,
      notes: c.notes,
      currentProposal: vigente
        ? MaintenancePlannerMapper.proposal(vigente)
        : null,
      lastProposal: ultima ? MaintenancePlannerMapper.proposal(ultima) : null,
      proposalsCount: c.proposals.length,
    };
  }

  static detalle(c: CasoCompleto): PlanningCaseDetailResponseDto {
    return {
      ...MaintenancePlannerMapper.caso(c),
      proposals: c.proposals.map((p) => MaintenancePlannerMapper.proposal(p)),
      windows: (c as MaintenancePlanningCase).evaluatedWindows,
    };
  }

  static vehiculo(
    v: VencimientosDeVehiculo,
    ahora: Date,
  ): ForecastVehicleResponseDto {
    return {
      carId: v.car.carId,
      patent: v.car.carPatent ?? null,
      typeCar: v.car.typeCar,
      odometerKm: v.car.odometerKm,
      kmPerDay: v.consumo ? Math.round(v.consumo.kmPorDia * 10) / 10 : null,
      usageSource: v.consumo?.source ?? null,
      historyDays: v.consumo?.diasDeHistorial ?? 0,
      lastUsageDay: v.consumo?.ultimoDia ?? null,
      usageStale: v.consumo?.desactualizado ?? false,
      nextWindow: v.proximaVentana
        ? {
            start: v.proximaVentana.start,
            end: v.proximaVentana.end,
            status: v.proximaVentana.estado,
          }
        : null,
      items: v.items.map(({ task, proyeccion, porVencer, caso }) => ({
        taskId: task.taskId,
        taskName: task.plan.name,
        criticality: task.plan.criticality,
        needsWorkshop: requiereTaller(task.plan),
        dueAt: task.dueAt,
        dueKm: task.dueKm,
        kmRemaining: proyeccion.kmFaltantes,
        predictedByKmAt: proyeccion.porKilometraje,
        projectedDueAt: proyeccion.fecha,
        daysLeft: proyeccion.fecha ? diasHasta(ahora, proyeccion.fecha) : null,
        dueSoon: porVencer,
        underObservation: proyeccion.enObservacion,
        scheduledAt: task.scheduledAt,
        caseId: caso?.caseId ?? null,
        caseStatus: caso?.status ?? null,
      })),
    };
  }
}
