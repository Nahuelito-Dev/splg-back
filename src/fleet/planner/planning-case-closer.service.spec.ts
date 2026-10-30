import { DataSource } from 'typeorm';
import { DeliveryService } from '../../delivery/delivery.service';
import { VehiculoDadoDeBajaEvent } from '../../car/events/vehiculo-dado-de-baja.event';
import {
  MaintenancePlanningCase,
  PlanningCaseStatus,
} from '../entities/maintenance-planning-case.entity';
import {
  MaintenanceWindowProposal,
  WindowProposalStatus,
} from '../entities/maintenance-window-proposal.entity';
import { MaintenancePlannerNotifier } from './maintenance-planner-notifier';
import { PlanningCaseCloser } from './planning-case-closer.service';
import { dataSourceEnMemoria, RepoEnMemoria } from './planner-test-kit';

const AHORA = new Date('2026-10-30T15:00:00Z');

describe('PlanningCaseCloser', () => {
  let cases: RepoEnMemoria<MaintenancePlanningCase>;
  let proposals: RepoEnMemoria<MaintenanceWindowProposal>;
  let notifier: { propuestaCerrada: jest.Mock };
  let deliveries: { findOne: jest.Mock };
  let closer: PlanningCaseCloser;
  let dataSource: ReturnType<typeof dataSourceEnMemoria>;

  const caso = (over: Partial<MaintenancePlanningCase>) =>
    cases.agregar({
      distributorId: 'd1',
      taskId: 't1',
      carId: 'car-1',
      status: PlanningCaseStatus.NEGOTIATING,
      ...over,
    } as MaintenancePlanningCase);
  const propuesta = (caseId: string, status = WindowProposalStatus.PENDING) =>
    proposals.agregar({
      caseId,
      deliveryId: 'del-1',
      status,
    } as MaintenanceWindowProposal);

  beforeEach(() => {
    cases = new RepoEnMemoria<MaintenancePlanningCase>('caseId');
    proposals = new RepoEnMemoria<MaintenanceWindowProposal>('proposalId');
    notifier = { propuestaCerrada: jest.fn() };
    deliveries = { findOne: jest.fn().mockResolvedValue({ userId: 'user-1' }) };
    dataSource = dataSourceEnMemoria(
      new Map<unknown, RepoEnMemoria<object>>([
        [MaintenancePlanningCase, cases as RepoEnMemoria<object>],
        [MaintenanceWindowProposal, proposals as RepoEnMemoria<object>],
      ]),
    );
    closer = new PlanningCaseCloser(
      dataSource as unknown as DataSource,
      deliveries as unknown as DeliveryService,
      notifier as unknown as MaintenancePlannerNotifier,
    );
  });

  it('cancela el caso abierto de la tarea con su motivo y la propuesta que esperaba: caso cancelado, pendiente cancelada, respondida intacta', async () => {
    const c = caso({ status: PlanningCaseStatus.AWAITING_CONFIRMATION });
    const pendiente = propuesta(c.caseId);
    const aceptada = propuesta(c.caseId, WindowProposalStatus.ACCEPTED);

    const cerradas = await dataSource.transaction((m) =>
      closer.cerrar(m as never, { taskId: 't1' }, 'La tarea se canceló', AHORA),
    );

    expect(c).toMatchObject({
      status: PlanningCaseStatus.CANCELLED,
      notes: 'La tarea se canceló',
      resolvedAt: AHORA,
    });
    expect(pendiente.status).toBe(WindowProposalStatus.CANCELLED);
    expect(aceptada.status).toBe(WindowProposalStatus.ACCEPTED);
    expect(cerradas).toEqual([pendiente]);
  });

  it('no toca un caso ya confirmado ni el de otra tarea', async () => {
    const confirmado = caso({ status: PlanningCaseStatus.CONFIRMED });
    const otra = caso({ taskId: 't2' });
    await dataSource.transaction((m) =>
      closer.cerrar(m as never, { taskId: 't1' }, 'x', AHORA),
    );
    expect(confirmado.status).toBe(PlanningCaseStatus.CONFIRMED);
    expect(otra.status).toBe(PlanningCaseStatus.NEGOTIATING);
  });

  it('avisa a cada chofer que su propuesta se cerró, y un error de aviso no se propaga', async () => {
    const c = caso({});
    const p = propuesta(c.caseId);
    deliveries.findOne.mockRejectedValueOnce(new Error('chofer inexistente'));
    await expect(closer.avisar([p])).resolves.toBeUndefined();
    await closer.avisar([p]);
    expect(notifier.propuestaCerrada).toHaveBeenCalledWith(
      'user-1',
      p.proposalId,
      'cancelled',
    );
  });

  it('dar de baja un vehículo cancela sus casos abiertos con motivo y avisa al chofer', async () => {
    const c1 = caso({});
    const c2 = caso({ taskId: 't2', status: PlanningCaseStatus.ESCALATED });
    const otroAuto = caso({ taskId: 't3', carId: 'car-9' });
    const p = propuesta(c1.caseId);

    await closer.alDarDeBajaElVehiculo(
      new VehiculoDadoDeBajaEvent('car-1', 'd1'),
    );

    expect(c1).toMatchObject({
      status: PlanningCaseStatus.CANCELLED,
      notes: 'El vehículo se dio de baja',
    });
    expect(c2.status).toBe(PlanningCaseStatus.CANCELLED);
    expect(otroAuto.status).toBe(PlanningCaseStatus.NEGOTIATING);
    expect(notifier.propuestaCerrada).toHaveBeenCalledWith(
      'user-1',
      p.proposalId,
      'cancelled',
    );
  });

  it('si algo falla al cerrar los casos del vehículo no rompe la baja', async () => {
    const roto = {
      transaction: () => Promise.reject(new Error('base caída')),
    };
    const c = new PlanningCaseCloser(
      roto as unknown as DataSource,
      deliveries as unknown as DeliveryService,
      notifier as unknown as MaintenancePlannerNotifier,
    );
    await expect(
      c.alDarDeBajaElVehiculo(new VehiculoDadoDeBajaEvent('car-1', 'd1')),
    ).resolves.toBeUndefined();
  });
});
