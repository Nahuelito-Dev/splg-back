import { FleetTaskMapper } from './fleet-task.mapper';
import {
  MaintenanceDocumentKind,
  MaintenancePlan,
} from './entities/maintenance-plan.entity';
import {
  MaintenanceTask,
  MaintenanceTaskStatus,
} from './entities/maintenance-task.entity';

const tarea = (
  over: Partial<MaintenanceTask> = {},
  documentKind: MaintenanceDocumentKind | null = null,
) =>
  ({
    taskId: 't1',
    status: MaintenanceTaskStatus.DONE,
    cost: 1000,
    cashMovementId: null,
    paidAt: null,
    paidAmount: null,
    plan: { name: 'VTV', documentKind, leadTimeDays: 0 } as MaintenancePlan,
    ...over,
  }) as MaintenanceTask;

describe('FleetTaskMapper.toV2Dto: payable', () => {
  it('hecha, con costo y sin pagar es pagable', () => {
    const dto = FleetTaskMapper.toV2Dto(tarea());
    expect(dto).toMatchObject({
      payable: true,
      isPaid: false,
      notPayableReason: null,
    });
  });

  it('una tarea de seguro no es pagable y dice que se paga por sus cuotas', () => {
    const dto = FleetTaskMapper.toV2Dto(
      tarea({}, MaintenanceDocumentKind.INSURANCE),
    );
    expect(dto.payable).toBe(false);
    expect(dto.notPayableReason).toBe('El seguro se paga por sus cuotas');
  });

  it.each([
    ['sin costo', { cost: null }],
    ['abierta', { status: MaintenanceTaskStatus.SCHEDULED }],
    ['ya paga', { cashMovementId: 'm1' }],
  ])('%s no es pagable', (_caso, cambio) => {
    expect(FleetTaskMapper.toV2Dto(tarea(cambio)).payable).toBe(false);
  });
});
