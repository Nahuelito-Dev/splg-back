import { ConsumptionController } from './consumption.controller';
import { ConsumptionService } from './consumption.service';
import { Customer } from '../customer/entities/customer.entity';

describe('ConsumptionController', () => {
  const ficha = {
    declaredCylinderTypeId: 'g10',
    declaredCylinderType: { type: '10kg' },
    avgMonthlyConsumptionKg: 20,
    nextRepurchaseEstimateAt: new Date('2026-10-16T00:00:00.000Z'),
  } as Customer;
  let service: { obtener: jest.Mock; actualizar: jest.Mock };
  let controller: ConsumptionController;

  beforeEach(() => {
    service = {
      obtener: jest.fn().mockResolvedValue(ficha),
      actualizar: jest.fn().mockResolvedValue(ficha),
    };
    controller = new ConsumptionController(
      service as unknown as ConsumptionService,
    );
  });

  it('GET devuelve el consumo con el tipo de garrafa legible', async () => {
    await expect(controller.obtener('u1')).resolves.toEqual({
      cylinderTypeId: 'g10',
      cylinderType: '10kg',
      avgMonthlyConsumptionKg: 20,
      nextRepurchaseEstimateAt: ficha.nextRepurchaseEstimateAt,
    });
  });

  it('PATCH actualiza el consumo del cliente del token', async () => {
    const dto = { quantityPerMonth: 2 };
    await controller.actualizar(dto, 'u1', 'd1');
    expect(service.actualizar).toHaveBeenCalledWith('u1', dto, 'd1');
  });

  it('sin tipo declarado, las claves salen en null', async () => {
    service.obtener.mockResolvedValue({
      declaredCylinderTypeId: null,
      avgMonthlyConsumptionKg: null,
      nextRepurchaseEstimateAt: null,
    });
    await expect(controller.obtener('u1')).resolves.toEqual({
      cylinderTypeId: null,
      cylinderType: null,
      avgMonthlyConsumptionKg: null,
      nextRepurchaseEstimateAt: null,
    });
  });
});
