import { Car } from '../car/entities/car.entity';
import { Employee } from '../employee/entities/employee.entity';
import { AdminGateway } from '../gateways/admin.gateway';
import { BoardColumn } from './domain/task-board';
import {
  MaintenanceDocumentKind,
  MaintenancePlan,
} from './entities/maintenance-plan.entity';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from './entities/maintenance-task.entity';
import { FleetTaskBoardMapper } from './fleet-task-board.mapper';
import {
  EVENTO_TAREA_DE_FLOTA,
  FleetTaskBoardNotifier,
} from './fleet-task-board.notifier';
import { FleetTaskBoardReader, TarjetaLeida } from './fleet-task-board.reader';

const AHORA = new Date('2026-11-17T15:00:00.000Z');

const leida = (
  over: Partial<MaintenanceTask> = {},
  plan: Partial<MaintenancePlan> = {},
): TarjetaLeida => ({
  task: {
    taskId: 't1',
    status: MaintenanceTaskStatus.SCHEDULED,
    dueAt: new Date('2026-12-31T00:00:00.000Z'),
    dueKm: null,
    scheduledAt: null,
    cost: 185000.5,
    boardPosition: 2048,
    updatedAt: AHORA,
    plan: {
      name: 'VTV',
      documentKind: MaintenanceDocumentKind.VTV,
      leadTimeDays: 30,
      ...plan,
    } as MaintenancePlan,
    car: undefined,
    assignee: null,
    ...over,
  } as MaintenanceTask,
  attachmentsCount: 2,
});

describe('FleetTaskBoardMapper.toCard', () => {
  it('arma la tarjeta con el plan, el vehículo, el responsable y los adjuntos', () => {
    const card = FleetTaskBoardMapper.toCard(
      leida({
        car: {
          carId: 'c1',
          carPatent: 'AB123CD',
          carBrand: 'Ford',
          carModel: 'Cargo',
        } as Car,
        assignee: {
          employeeId: 'e1',
          firstName: 'Juan',
          lastName: 'Pérez',
        } as Employee,
      }),
      AHORA,
    );
    expect(card).toEqual({
      id: 't1',
      title: 'VTV',
      category: 'vtv',
      status: 'scheduled',
      column: BoardColumn.SCHEDULED,
      isOverdue: false,
      dueAt: new Date('2026-12-31T00:00:00.000Z'),
      dueKm: null,
      scheduledAt: null,
      car: { id: 'c1', plate: 'AB123CD', label: 'Ford Cargo' },
      assignee: { employeeId: 'e1', name: 'Pérez, Juan' },
      attachmentsCount: 2,
      cost: 185000.5,
      position: 2048,
      updatedAt: AHORA,
    });
  });

  it('sin marca ni modelo, la etiqueta del vehículo es el tipo o la patente', () => {
    const conTipo = FleetTaskBoardMapper.toCard(
      leida({
        car: { carId: 'c1', carPatent: 'AB1', typeCar: 'Moto' } as Car,
      }),
      AHORA,
    );
    const soloPatente = FleetTaskBoardMapper.toCard(
      leida({ car: { carId: 'c1', carPatent: 'AB1' } as Car }),
      AHORA,
    );
    expect(conTipo.car?.label).toBe('Moto');
    expect(soloPatente.car?.label).toBe('AB1');
  });

  it('un plan sin tipo es `generic`', () => {
    expect(
      FleetTaskBoardMapper.toCard(leida({}, { documentKind: null }), AHORA)
        .category,
    ).toBe('generic');
  });

  it('abierta con el vencimiento pasado: isOverdue, en su columna', () => {
    const card = FleetTaskBoardMapper.toCard(
      leida({ dueAt: new Date('2026-11-10T00:00:00.000Z') }),
      AHORA,
    );
    expect(card).toMatchObject({ isOverdue: true, column: 'scheduled' });
  });

  it('el estado heredado `overdue` también es vencida, en la columna de su turno', () => {
    const card = FleetTaskBoardMapper.toCard(
      leida({ status: MaintenanceTaskStatus.OVERDUE, dueAt: null }),
      AHORA,
    );
    expect(card).toMatchObject({ isOverdue: true, column: 'forecast' });
  });

  it.each([MaintenanceTaskStatus.DONE, MaintenanceTaskStatus.CANCELLED])(
    '%s con el vencimiento pasado no es vencida',
    (status) => {
      const card = FleetTaskBoardMapper.toCard(
        leida({ status, dueAt: new Date('2026-01-01T00:00:00.000Z') }),
        AHORA,
      );
      expect(card.isOverdue).toBe(false);
    },
  );
});

describe('FleetTaskBoardNotifier', () => {
  it('emite `fleet:task` con la tarjeta a la sala de la empresa, una por tarea', async () => {
    const lector = {
      tarjetas: jest.fn().mockResolvedValue([leida(), leida({ taskId: 't2' })]),
    };
    const gateway = { emitirALaFlota: jest.fn(), notifyAdmins: jest.fn() };
    const avisos = new FleetTaskBoardNotifier(
      lector as unknown as FleetTaskBoardReader,
      gateway as unknown as AdminGateway,
    );
    await avisos.avisarVarias('d1', ['t1', 't2'], 'overdue');
    expect(lector.tarjetas).toHaveBeenCalledWith(['t1', 't2'], 'd1');
    // Sólo a la sala de la flota (quien tiene `flota.ver`), nunca a todo el personal.
    expect(gateway.notifyAdmins).not.toHaveBeenCalled();
    expect(gateway.emitirALaFlota).toHaveBeenCalledTimes(2);
    expect(gateway.emitirALaFlota).toHaveBeenCalledWith(
      'd1',
      EVENTO_TAREA_DE_FLOTA,
      {
        id: 't2',
        change: 'overdue',
        card: expect.objectContaining({ id: 't2', title: 'VTV' }) as unknown,
      },
    );
  });

  it('si no puede leer la tarjeta no rompe la operación ya hecha', async () => {
    const lector = {
      tarjetas: jest.fn().mockRejectedValue(new Error('caída')),
    };
    const gateway = { emitirALaFlota: jest.fn(), notifyAdmins: jest.fn() };
    const avisos = new FleetTaskBoardNotifier(
      lector as unknown as FleetTaskBoardReader,
      gateway as unknown as AdminGateway,
    );
    await expect(avisos.avisar('d1', 't1', 'moved')).resolves.toBeUndefined();
    expect(gateway.emitirALaFlota).not.toHaveBeenCalled();
  });
});
