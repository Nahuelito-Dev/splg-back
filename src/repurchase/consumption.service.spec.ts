import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConsumptionService } from './consumption.service';
import { CustomersService } from '../customer/customer.service';
import { Customer } from '../customer/entities/customer.entity';
import { GasCylinder } from '../gascylinder/entities/gascylinder.entity';
import { GasCylinderService } from '../gascylinder/gascylinder.service';
import { OrderLookupService } from '../order/lookup/order-lookup.service';

const garrafa = (parcial: Partial<GasCylinder> = {}): GasCylinder =>
  ({
    gasCylinderId: 'g10',
    type: '10kg',
    weight: 10,
    isActive: true,
    ...parcial,
  }) as GasCylinder;

describe('ConsumptionService', () => {
  const ahora = new Date('2026-10-01T00:00:00.000Z');
  let customers: { findOneByUserId: jest.Mock; guardarConsumo: jest.Mock };
  let catalogo: { findOne: jest.Mock };
  let pedidos: { ultimaCompraEntregada: jest.Mock };
  let service: ConsumptionService;

  beforeEach(() => {
    customers = {
      findOneByUserId: jest
        .fn()
        .mockResolvedValue({ declaredCylinderTypeId: 'g10' } as Customer),
      guardarConsumo: jest.fn().mockResolvedValue({} as Customer),
    };
    catalogo = { findOne: jest.fn().mockResolvedValue(garrafa()) };
    pedidos = { ultimaCompraEntregada: jest.fn().mockResolvedValue(null) };
    service = new ConsumptionService(
      customers as unknown as CustomersService,
      catalogo as unknown as GasCylinderService,
      pedidos as unknown as OrderLookupService,
    );
  });

  describe('calcularDeclaracion (CU-143)', () => {
    it('convierte a kilos con el peso del tipo y estima desde ahora con la garrafa llena', async () => {
      const r = await service.calcularDeclaracion(
        { cylinderTypeId: 'g10', quantityPerMonth: 2 },
        ahora,
      );

      expect(r).toEqual({
        declaredCylinderTypeId: 'g10',
        avgMonthlyConsumptionKg: 20,
        nextRepurchaseEstimateAt: new Date('2026-10-16T00:00:00.000Z'),
      });
    });

    it('fuera de rango pide confirmación', async () => {
      await expect(
        service.calcularDeclaracion(
          { cylinderTypeId: 'g10', quantityPerMonth: 0.1 },
          ahora,
        ),
      ).rejects.toThrow(/confirmOutOfRange/);
      await expect(
        service.calcularDeclaracion(
          { cylinderTypeId: 'g10', quantityPerMonth: 60 },
          ahora,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('fuera de rango y confirmado, lo acepta', async () => {
      const r = await service.calcularDeclaracion(
        {
          cylinderTypeId: 'g10',
          quantityPerMonth: 60,
          confirmOutOfRange: true,
        },
        ahora,
      );

      expect(r.avgMonthlyConsumptionKg).toBe(600);
    });

    it('un tipo inexistente o dado de baja es 400', async () => {
      catalogo.findOne.mockRejectedValueOnce(new NotFoundException('no'));
      await expect(
        service.calcularDeclaracion({
          cylinderTypeId: 'x',
          quantityPerMonth: 1,
        }),
      ).rejects.toThrow(BadRequestException);

      catalogo.findOne.mockResolvedValueOnce(garrafa({ isActive: false }));
      await expect(
        service.calcularDeclaracion({
          cylinderTypeId: 'g10',
          quantityPerMonth: 1,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('un consumo en cero se rechaza aunque venga confirmado', async () => {
      catalogo.findOne.mockResolvedValue(garrafa({ weight: 0 }));

      await expect(
        service.calcularDeclaracion({
          cylinderTypeId: 'g10',
          quantityPerMonth: 1,
          confirmOutOfRange: true,
        }),
      ).rejects.toThrow(/mayor que cero/);
    });

    it('un error que no es de "no existe" se propaga', async () => {
      catalogo.findOne.mockRejectedValueOnce(new Error('base caída'));
      await expect(
        service.calcularDeclaracion({
          cylinderTypeId: 'g10',
          quantityPerMonth: 1,
        }),
      ).rejects.toThrow('base caída');
    });
  });

  describe('actualizar (CU-144)', () => {
    it('sin compras estima desde ahora', async () => {
      await service.actualizar('u1', { quantityPerMonth: 1 }, null, ahora);

      expect(customers.guardarConsumo).toHaveBeenCalledWith('u1', {
        declaredCylinderTypeId: 'g10',
        avgMonthlyConsumptionKg: 10,
        nextRepurchaseEstimateAt: new Date('2026-10-31T00:00:00.000Z'),
      });
    });

    it('con compras estima desde la última entregada y sus kilos', async () => {
      pedidos.ultimaCompraEntregada.mockResolvedValue({
        deliveredAt: new Date('2026-09-01T00:00:00.000Z'),
        kg: 20,
      });

      await service.actualizar('u1', { quantityPerMonth: 1 }, null, ahora);

      expect(pedidos.ultimaCompraEntregada).toHaveBeenCalledWith('u1');
      expect(customers.guardarConsumo).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({
          nextRepurchaseEstimateAt: new Date('2026-10-31T00:00:00.000Z'),
        }),
      );
    });

    it('sólo cambiar la garrafa mantiene los kg por mes y recalcula con el peso nuevo', async () => {
      customers.findOneByUserId.mockResolvedValue({
        declaredCylinderTypeId: 'g10',
        avgMonthlyConsumptionKg: 20,
      });
      catalogo.findOne.mockResolvedValue(
        garrafa({ gasCylinderId: 'g45', weight: 45 }),
      );

      await service.actualizar('u1', { cylinderTypeId: 'g45' }, null, ahora);

      expect(customers.guardarConsumo).toHaveBeenCalledWith('u1', {
        declaredCylinderTypeId: 'g45',
        avgMonthlyConsumptionKg: 20,
        nextRepurchaseEstimateAt: new Date('2026-12-07T12:00:00.000Z'),
      });
    });

    it('sin cantidad ni garrafa, o sin consumo previo, pide la cantidad', async () => {
      await expect(service.actualizar('u1', {}, null, ahora)).rejects.toThrow(
        /quantityPerMonth/,
      );

      customers.findOneByUserId.mockResolvedValue({
        declaredCylinderTypeId: null,
        avgMonthlyConsumptionKg: null,
      });
      await expect(
        service.actualizar('u1', { cylinderTypeId: 'g10' }, null, ahora),
      ).rejects.toThrow(/quantityPerMonth/);
      expect(customers.guardarConsumo).not.toHaveBeenCalled();
    });

    it('fuera de rango sin confirmar no guarda nada', async () => {
      await expect(
        service.actualizar('u1', { quantityPerMonth: 100 }, null, ahora),
      ).rejects.toThrow(BadRequestException);
      expect(customers.guardarConsumo).not.toHaveBeenCalled();
    });

    it('sin tipo habitual declarado exige indicarlo', async () => {
      customers.findOneByUserId.mockResolvedValue({
        declaredCylinderTypeId: null,
      });

      await expect(
        service.actualizar('u1', { quantityPerMonth: 1 }, null, ahora),
      ).rejects.toThrow(/cylinderTypeId/);
    });

    it('un tipo indicado se acota a la distribuidora en contexto; el declarado antes, no', async () => {
      await service.actualizar(
        'u1',
        { cylinderTypeId: 'g10', quantityPerMonth: 1 },
        'd1',
        ahora,
      );
      expect(catalogo.findOne).toHaveBeenLastCalledWith('g10', 'd1');

      await service.actualizar('u1', { quantityPerMonth: 1 }, 'd1', ahora);
      expect(catalogo.findOne).toHaveBeenLastCalledWith('g10', null);
    });
  });

  it('obtener devuelve la ficha del cliente', async () => {
    await service.obtener('u1');
    expect(customers.findOneByUserId).toHaveBeenCalledWith('u1');
  });

  describe('recalcularTrasEntrega', () => {
    const declarado = {
      declaredCylinderTypeId: 'g10',
      avgMonthlyConsumptionKg: 30,
    } as Customer;

    it('arranca la estimación del consumo declarado desde la compra entregada', async () => {
      customers.findOneByUserId.mockResolvedValue(declarado);
      pedidos.ultimaCompraEntregada.mockResolvedValue({
        deliveredAt: new Date('2026-10-01T00:00:00.000Z'),
        kg: 10,
      });

      await service.recalcularTrasEntrega('u1');

      // 10 kg a 30 kg por mes: 10 días.
      expect(customers.guardarConsumo).toHaveBeenCalledWith('u1', {
        declaredCylinderTypeId: 'g10',
        avgMonthlyConsumptionKg: 30,
        nextRepurchaseEstimateAt: new Date('2026-10-11T00:00:00.000Z'),
      });
    });

    it('sin consumo declarado no hay nada que recalcular', async () => {
      customers.findOneByUserId.mockResolvedValue({
        declaredCylinderTypeId: null,
        avgMonthlyConsumptionKg: null,
      } as Customer);
      await service.recalcularTrasEntrega('u1');
      expect(pedidos.ultimaCompraEntregada).not.toHaveBeenCalled();
      expect(customers.guardarConsumo).not.toHaveBeenCalled();
    });

    it('sin compras entregadas deja la estimación como está', async () => {
      customers.findOneByUserId.mockResolvedValue(declarado);
      pedidos.ultimaCompraEntregada.mockResolvedValue(null);
      await service.recalcularTrasEntrega('u1');
      expect(customers.guardarConsumo).not.toHaveBeenCalled();
    });
  });
});
