import { MaintenancePlannerMapper } from './maintenance-planner.mapper';
import {
  MaintenanceCriticality,
  MaintenanceDocumentKind,
} from '../entities/maintenance-plan.entity';
import {
  PlanningCaseStatus,
  PlanningEscalationReason,
} from '../entities/maintenance-planning-case.entity';
import {
  MaintenanceWindowProposal,
  WindowProposalStatus,
} from '../entities/maintenance-window-proposal.entity';
import type {
  CasoCompleto,
  VencimientosDeVehiculo,
} from './maintenance-planner.service';

const prop = (rank: number, status: WindowProposalStatus) =>
  ({
    proposalId: `p${rank}`,
    caseId: 'c1',
    taskId: 't1',
    windowStart: new Date('2026-11-02T11:00:00Z'),
    windowEnd: new Date('2026-11-02T16:00:00Z'),
    rank,
    status,
    expiresAt: new Date('2026-10-31T11:00:00Z'),
    respondedAt: null,
    rejectionReason: null,
    altWindowStart: null,
    altWindowEnd: null,
  }) as MaintenanceWindowProposal;

const caso = (over: Partial<CasoCompleto> = {}): CasoCompleto =>
  ({
    caseId: 'c1',
    status: PlanningCaseStatus.NEGOTIATING,
    taskId: 't1',
    task: {
      plan: { name: 'VTV', criticality: MaintenanceCriticality.BLOCKING },
    },
    carId: 'car-1',
    car: { carPatent: 'AB123CD' },
    deliveryId: 'del-1',
    delivery: { user: { fullName: 'Ana Pérez' } },
    projectedDueAt: new Date('2026-11-05T00:00:00Z'),
    openedAt: new Date('2026-10-30T00:00:00Z'),
    escalationReason: null,
    evaluatedWindows: [],
    proposals: [],
    ...over,
  }) as unknown as CasoCompleto;

describe('MaintenancePlannerMapper', () => {
  it('el caso muestra la propuesta vigente y la última respuesta', () => {
    const dto = MaintenancePlannerMapper.caso(
      caso({
        proposals: [
          prop(1, WindowProposalStatus.REJECTED),
          prop(2, WindowProposalStatus.PENDING),
        ],
      }),
    );
    expect(dto.currentProposal?.proposalId).toBe('p2');
    expect(dto.lastProposal?.proposalId).toBe('p1');
    expect(dto.proposalsCount).toBe(2);
    expect(dto.driverName).toBe('Ana Pérez');
    expect(dto.patent).toBe('AB123CD');
  });

  it('un caso escalado trae el motivo en castellano', () => {
    const dto = MaintenancePlannerMapper.caso(
      caso({
        status: PlanningCaseStatus.ESCALATED,
        escalationReason: PlanningEscalationReason.NO_DRIVER,
        delivery: null,
        deliveryId: null,
      }),
    );
    expect(dto.escalationText).toContain('chofer');
    expect(dto.driverName).toBeNull();
    expect(dto.currentProposal).toBeNull();
  });

  it('el detalle suma las propuestas y el cuadro de ventanas', () => {
    const c = caso({
      proposals: [prop(1, WindowProposalStatus.PENDING)],
      evaluatedWindows: [
        {
          start: 'a',
          end: 'b',
          demand: 1,
          unitsLeft: 2,
          urgent: false,
          offered: true,
          discardReason: null,
        },
      ],
    });
    const dto = MaintenancePlannerMapper.detalle(c);
    expect(dto.proposals).toHaveLength(1);
    expect(dto.windows).toHaveLength(1);
  });

  it('la propuesta del chofer lleva la tarea y el vehículo', () => {
    const p = {
      ...prop(1, WindowProposalStatus.PENDING),
      task: {
        carId: 'car-1',
        plan: { name: 'Service' },
        car: { carPatent: 'AB123CD' },
      },
      planningCase: {
        status: PlanningCaseStatus.NEGOTIATING,
        projectedDueAt: new Date('2026-11-20T03:00:00Z'),
      },
    } as unknown as MaintenanceWindowProposal;
    expect(MaintenancePlannerMapper.driverProposal(p)).toMatchObject({
      taskName: 'Service',
      carId: 'car-1',
      patent: 'AB123CD',
      caseStatus: PlanningCaseStatus.NEGOTIATING,
      urgent: false,
      confirmedStart: null,
      confirmedEnd: null,
    });
  });

  it('el chofer ve si el administrador ya confirmó y si su turno es urgente', () => {
    const p = {
      ...prop(1, WindowProposalStatus.ACCEPTED),
      task: { carId: 'car-1', plan: { name: 'VTV' }, car: null },
      planningCase: {
        status: PlanningCaseStatus.CONFIRMED,
        projectedDueAt: new Date('2026-11-01T03:00:00Z'),
        chosenStart: new Date('2026-11-04T12:00:00Z'),
        chosenEnd: new Date('2026-11-04T14:00:00Z'),
      },
    } as unknown as MaintenanceWindowProposal;
    expect(MaintenancePlannerMapper.driverProposal(p)).toMatchObject({
      caseStatus: PlanningCaseStatus.CONFIRMED,
      urgent: true,
      projectedDueAt: '2026-11-01T03:00:00.000Z',
      confirmedStart: '2026-11-04T12:00:00.000Z',
      confirmedEnd: '2026-11-04T14:00:00.000Z',
    });
  });

  it('el vehículo redondea el consumo y marca lo que no pasa por un taller', () => {
    const v = {
      car: {
        carId: 'car-1',
        carPatent: 'AB123CD',
        typeCar: 'Camioneta',
        odometerKm: 1000,
      },
      consumo: {
        kmPorDia: 12.345,
        source: 'own',
        diasDeHistorial: 50,
        muestras: [],
      },
      proximaVentana: null,
      items: [
        {
          task: {
            taskId: 't1',
            dueAt: new Date('2026-11-10T00:00:00Z'),
            dueKm: null,
            scheduledAt: null,
            plan: {
              name: 'Seguro',
              criticality: MaintenanceCriticality.BLOCKING,
              documentKind: MaintenanceDocumentKind.INSURANCE,
            },
          },
          proyeccion: {
            fecha: new Date('2026-11-10T15:00:00Z'),
            porKilometraje: null,
            kmFaltantes: null,
            enObservacion: false,
          },
          porVencer: false,
          caso: null,
        },
      ],
    } as unknown as VencimientosDeVehiculo;

    const dto = MaintenancePlannerMapper.vehiculo(
      v,
      new Date('2026-10-30T15:00:00Z'),
    );

    expect(dto.kmPerDay).toBe(12.3);
    expect(dto.items[0]).toMatchObject({
      needsWorkshop: false,
      daysLeft: 11,
      caseId: null,
    });
  });

  it('cada tarea dice qué corrección por desvío se le aplicó y de qué fecha partió', () => {
    const sinCorregir = new Date('2026-11-10T15:00:00Z');
    const v = {
      car: { carId: 'c', carPatent: null, typeCar: null, odometerKm: 1 },
      consumo: null,
      proximaVentana: null,
      items: [
        {
          task: {
            taskId: 't1',
            dueAt: null,
            dueKm: 2000,
            scheduledAt: null,
            plan: {
              name: 'Service',
              criticality: MaintenanceCriticality.NON_BLOCKING,
              documentKind: MaintenanceDocumentKind.SERVICE,
            },
          },
          proyeccion: {
            fecha: new Date('2026-11-16T15:00:00Z'),
            porKilometraje: new Date('2026-11-16T15:00:00Z'),
            porKilometrajeSinCorregir: sinCorregir,
            correccion: {
              correctionDays: 6,
              averageDeviationDays: 6.4,
              samples: 5,
              capped: false,
              source: 'vehicle_task_type',
            },
            kmFaltantes: 1000,
            enObservacion: false,
          },
          porVencer: false,
          caso: null,
        },
      ],
    } as unknown as VencimientosDeVehiculo;

    const dto = MaintenancePlannerMapper.vehiculo(
      v,
      new Date('2026-10-30T15:00:00Z'),
    );

    expect(dto.items[0].calibration).toEqual({
      correctionDays: 6,
      averageDeviationDays: 6.4,
      samples: 5,
      capped: false,
      source: 'vehicle_task_type',
      uncorrectedAt: sinCorregir,
    });
  });

  it('una tarea sin corrección lo dice con null', () => {
    const dto = MaintenancePlannerMapper.vehiculo(
      {
        car: { carId: 'c', carPatent: null, typeCar: null, odometerKm: null },
        consumo: null,
        proximaVentana: null,
        items: [
          {
            task: {
              taskId: 't1',
              dueAt: null,
              dueKm: 10,
              scheduledAt: null,
              plan: {
                name: 'x',
                criticality: MaintenanceCriticality.NON_BLOCKING,
                documentKind: MaintenanceDocumentKind.SERVICE,
              },
            },
            proyeccion: {
              fecha: null,
              porKilometraje: null,
              porKilometrajeSinCorregir: null,
              correccion: null,
              kmFaltantes: null,
              enObservacion: true,
            },
            porVencer: false,
            caso: null,
          },
        ],
      } as unknown as VencimientosDeVehiculo,
      new Date(),
    );
    expect(dto.items[0].calibration).toBeNull();
  });

  it('un vehículo sin consumo no inventa uno', () => {
    const dto = MaintenancePlannerMapper.vehiculo(
      {
        car: { carId: 'c', carPatent: null, typeCar: null, odometerKm: null },
        consumo: null,
        proximaVentana: {
          start: new Date(),
          end: new Date(),
          estado: PlanningCaseStatus.CONFIRMED,
        },
        items: [],
      } as unknown as VencimientosDeVehiculo,
      new Date(),
    );
    expect(dto.kmPerDay).toBeNull();
    expect(dto.usageSource).toBeNull();
    expect(dto.nextWindow?.status).toBe('confirmed');
  });
});
