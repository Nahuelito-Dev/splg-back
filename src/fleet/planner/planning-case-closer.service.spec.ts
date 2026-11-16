import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DeliveryService } from '../../delivery/delivery.service';
import { VehiculoDadoDeBajaEvent } from '../../car/events/vehiculo-dado-de-baja.event';
import {
  MaintenancePlanningCase,
  PlanningCaseStatus,
  PlanningWindowSource,
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

  describe('reprogramarConfirmado: el turno agendado de la tarea cambió', () => {
    // 11:00-16:00 UTC = 08:00-13:00 ART del 02/11
    const confirmado = (over: Partial<MaintenancePlanningCase> = {}) =>
      caso({
        status: PlanningCaseStatus.CONFIRMED,
        chosenStart: new Date('2026-11-02T11:00:00Z'),
        chosenEnd: new Date('2026-11-02T16:00:00Z'),
        chosenSource: PlanningWindowSource.DRIVER_ACCEPTED,
        resolvedAt: new Date('2026-10-30T12:00:00Z'),
        ...over,
      });
    const reprogramar = (
      destino: Parameters<PlanningCaseCloser['reprogramarConfirmado']>[2],
    ) =>
      dataSource.transaction((m) =>
        closer.reprogramarConfirmado(m as never, 't1', destino, 'u1', AHORA),
      );

    it('un día mueve la ventana a ese día conservando la hora de inicio y la duración, y deja quién', async () => {
      const c = confirmado();
      const inicio = await reprogramar({ dia: '2026-11-05' });
      expect(c.status).toBe(PlanningCaseStatus.CONFIRMED);
      expect(c.chosenStart).toEqual(new Date('2026-11-05T11:00:00Z'));
      expect(c.chosenEnd).toEqual(new Date('2026-11-05T16:00:00Z'));
      expect(inicio).toEqual(c.chosenStart);
      expect(c.chosenSource).toBe(PlanningWindowSource.ADMIN);
      expect(c.resolvedByUserId).toBe('u1');
      expect(c.resolvedAt).toEqual(new Date('2026-10-30T12:00:00Z'));
      expect(c.notes).toContain('reprogramó');
    });

    it('el día es el argentino: una ventana de las 22:00 ART cae a las 22:00 ART del día nuevo (01:00 UTC del siguiente)', async () => {
      const c = confirmado({
        chosenStart: new Date('2026-11-02T01:00:00Z'),
        chosenEnd: new Date('2026-11-02T03:00:00Z'),
      });
      await reprogramar({ dia: '2026-11-05' });
      expect(c.chosenStart).toEqual(new Date('2026-11-06T01:00:00Z'));
      expect(c.chosenEnd).toEqual(new Date('2026-11-06T03:00:00Z'));
    });

    it('un instante con hora arranca la ventana a esa hora, con la misma duración', async () => {
      const c = confirmado();
      const inicio = await reprogramar({
        inicio: new Date('2026-11-05T15:30:00Z'),
      });
      expect(c.chosenStart).toEqual(new Date('2026-11-05T15:30:00Z'));
      expect(c.chosenEnd).toEqual(new Date('2026-11-05T20:30:00Z'));
      expect(inicio).toEqual(new Date('2026-11-05T15:30:00Z'));
    });

    it('una ventana nueva que arranca en el pasado se rechaza (400) y el caso queda como estaba', async () => {
      const c = confirmado();
      await expect(
        reprogramar({ inicio: new Date('2026-10-30T10:00:00Z') }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(c.chosenStart).toEqual(new Date('2026-11-02T11:00:00Z'));
    });

    it('acepta una ventana que arranca dentro del margen de 5 minutos', async () => {
      confirmado();
      await expect(
        reprogramar({ inicio: new Date('2026-10-30T14:56:00Z') }),
      ).resolves.toBeInstanceOf(Date);
    });

    it('sin turno cancela el caso con su motivo y deja quién', async () => {
      const c = confirmado();
      const inicio = await reprogramar(null);
      expect(c).toMatchObject({
        status: PlanningCaseStatus.CANCELLED,
        resolvedAt: AHORA,
        resolvedByUserId: 'u1',
      });
      expect(c.notes).toContain('administrador');
      expect(inicio).toBeUndefined();
    });

    it('lee el caso con la fila bloqueada', async () => {
      confirmado();
      const find = jest.spyOn(cases, 'find');
      await reprogramar(null);
      expect(find).toHaveBeenCalledWith(
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
    });

    it('no toca una ventana que ya terminó, ni un caso de otra tarea, ni uno abierto', async () => {
      const vieja = caso({
        status: PlanningCaseStatus.CONFIRMED,
        chosenStart: new Date('2026-10-20T11:00:00Z'),
        chosenEnd: new Date('2026-10-20T16:00:00Z'),
      });
      const otra = caso({
        taskId: 't2',
        status: PlanningCaseStatus.CONFIRMED,
        chosenStart: new Date('2026-11-02T11:00:00Z'),
        chosenEnd: new Date('2026-11-02T16:00:00Z'),
      });
      const abierto = caso({ status: PlanningCaseStatus.ESCALATED });
      await reprogramar(null);
      expect(vieja.status).toBe(PlanningCaseStatus.CONFIRMED);
      expect(otra.status).toBe(PlanningCaseStatus.CONFIRMED);
      expect(abierto.status).toBe(PlanningCaseStatus.ESCALATED);
    });
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
