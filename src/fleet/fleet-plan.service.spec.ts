import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { FleetPlanService } from './fleet-plan.service';
import {
  MaintenanceCriticality,
  MaintenancePlan,
  MaintenanceSubject,
  MaintenanceTrigger,
} from './entities/maintenance-plan.entity';

/**
 * Un plan es de una distribuidora (nunca se ve/edita el de otra) y sus datos
 * de intervalo tienen que ser coherentes con el disparador elegido.
 */
describe('FleetPlanService', () => {
  let service: FleetPlanService;
  let plans: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };

  const dtoBase = {
    name: 'Seguro del vehículo',
    subject: MaintenanceSubject.VEHICLE,
    trigger: MaintenanceTrigger.BY_FIXED_DATE,
    leadTimeDays: 30,
    criticality: MaintenanceCriticality.BLOCKING,
  };

  beforeEach(() => {
    plans = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((p: Partial<MaintenancePlan>) => p),
      save: jest.fn((p: MaintenancePlan) => Promise.resolve(p)),
    };
    service = new FleetPlanService(
      plans as unknown as Repository<MaintenancePlan>,
    );
  });

  it('se crea en la distribuidora del admin', async () => {
    const plan = await service.create(dtoBase, 'd1');
    expect(plan).toMatchObject({ name: dtoBase.name, distributorId: 'd1' });
  });

  it('un plan por km necesita intervalKm', async () => {
    await expect(
      service.create({ ...dtoBase, trigger: MaintenanceTrigger.BY_KM }, 'd1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('un plan por tiempo necesita intervalMonths', async () => {
    await expect(
      service.create({ ...dtoBase, trigger: MaintenanceTrigger.BY_TIME }, 'd1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('un plan por fecha fija no lleva intervalKm ni intervalMonths', async () => {
    await expect(
      service.create({ ...dtoBase, intervalKm: 5000 }, 'd1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('un plan por km válido se crea sin problema', async () => {
    const plan = await service.create(
      {
        ...dtoBase,
        trigger: MaintenanceTrigger.BY_KM,
        intervalKm: 10000,
      },
      'd1',
    );
    expect(plan).toMatchObject({ intervalKm: 10000 });
  });

  it('un admin no ve planes de otra distribuidora', async () => {
    plans.findOne.mockResolvedValue(null);
    await expect(service.findOne('p1', 'd2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('al editar, valida la coherencia con los valores finales (no sólo los que llegan)', async () => {
    plans.findOne.mockResolvedValue({
      planId: 'p1',
      distributorId: 'd1',
      trigger: MaintenanceTrigger.BY_KM,
      intervalKm: 10000,
      intervalMonths: null,
    });
    await expect(
      service.update(
        'p1',
        { intervalKm: undefined as unknown as number },
        'd1',
      ),
    ).resolves.toBeDefined();
  });

  it('filtra por subject e isActive', async () => {
    plans.find.mockResolvedValue([]);
    await service.findAll('d1', {
      subject: MaintenanceSubject.DRIVER,
      isActive: true,
    });
    expect(plans.find).toHaveBeenCalledWith({
      where: {
        distributorId: 'd1',
        subject: MaintenanceSubject.DRIVER,
        isActive: true,
      },
      order: { name: 'ASC' },
    });
  });
});
