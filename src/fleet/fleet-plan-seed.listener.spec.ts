import { Repository } from 'typeorm';
import { MaintenancePlan } from './entities/maintenance-plan.entity';
import { FleetPlanSeedListener } from './fleet-plan-seed.listener';
import { BASE_PLAN_DEFINITIONS } from './domain/base-plans';
import { DistribuidoraCreadaEvent } from '../distributor/events/distribuidora-creada.event';

describe('FleetPlanSeedListener', () => {
  let listener: FleetPlanSeedListener;
  let plans: { count: jest.Mock; create: jest.Mock; save: jest.Mock };

  beforeEach(() => {
    plans = {
      count: jest.fn(),
      create: jest.fn((p: Partial<MaintenancePlan>) => p),
      save: jest.fn((p: MaintenancePlan[]) => Promise.resolve(p)),
    };
    listener = new FleetPlanSeedListener(
      plans as unknown as Repository<MaintenancePlan>,
    );
  });

  it('siembra los 4 planes base para una distribuidora nueva', async () => {
    plans.count.mockResolvedValue(0);
    await listener.handle(new DistribuidoraCreadaEvent('d1'));

    expect(plans.save).toHaveBeenCalledTimes(1);
    const llamadas = plans.save.mock.calls as [Partial<MaintenancePlan>[]][];
    const [[guardados]] = llamadas;
    expect(guardados).toHaveLength(BASE_PLAN_DEFINITIONS.length);
    expect(guardados.every((p) => p.distributorId === 'd1')).toBe(true);
    expect(guardados.map((p) => p.name)).toEqual(
      BASE_PLAN_DEFINITIONS.map((d) => d.name),
    );
  });

  it('es idempotente: si ya tiene planes, no siembra de nuevo', async () => {
    plans.count.mockResolvedValue(4);
    await listener.handle(new DistribuidoraCreadaEvent('d1'));

    expect(plans.save).not.toHaveBeenCalled();
  });
});
