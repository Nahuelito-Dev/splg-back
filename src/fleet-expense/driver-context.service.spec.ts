import { NotFoundException } from '@nestjs/common';
import { VehicleAssignmentService } from '../car/vehicle-assignment.service';
import { DeliveryService } from '../delivery/delivery.service';
import { EmployeeService } from '../employee/employee.service';
import { DriverContextService } from './driver-context.service';

describe('DriverContextService', () => {
  let service: DriverContextService;
  let deliveries: { findDeliveryIdsByUserIds: jest.Mock; findOne: jest.Mock };
  let assignments: {
    findVehiculosEnUsoPorDeliveryIds: jest.Mock;
    choferDelVehiculoEn: jest.Mock;
  };
  let employees: { findByUserIdEnDistribuidora: jest.Mock; findOne: jest.Mock };

  beforeEach(() => {
    deliveries = {
      findDeliveryIdsByUserIds: jest.fn(),
      findOne: jest.fn(),
    };
    assignments = {
      findVehiculosEnUsoPorDeliveryIds: jest.fn(),
      choferDelVehiculoEn: jest.fn(),
    };
    employees = { findByUserIdEnDistribuidora: jest.fn(), findOne: jest.fn() };
    service = new DriverContextService(
      deliveries as unknown as DeliveryService,
      assignments as unknown as VehicleAssignmentService,
      employees as unknown as EmployeeService,
    );
  });

  describe('vehiculoEnUso', () => {
    it('devuelve el vehículo que el chofer tiene en uso', async () => {
      deliveries.findDeliveryIdsByUserIds.mockResolvedValue([
        { deliveryId: 'dl1', userId: 'u1' },
      ]);
      assignments.findVehiculosEnUsoPorDeliveryIds.mockResolvedValue([
        { deliveryId: 'dl1', carId: 'c1' },
      ]);
      await expect(service.vehiculoEnUso('u1', 'd1')).resolves.toBe('c1');
    });

    it('sin vehículo en uso, 404 «No tenés un vehículo en uso»', async () => {
      deliveries.findDeliveryIdsByUserIds.mockResolvedValue([
        { deliveryId: 'dl1', userId: 'u1' },
      ]);
      assignments.findVehiculosEnUsoPorDeliveryIds.mockResolvedValue([]);
      await expect(service.vehiculoEnUso('u1', 'd1')).rejects.toThrow(
        'No tenés un vehículo en uso',
      );
    });

    it('un usuario sin perfil de chofer de esa distribuidora tampoco tiene vehículo', async () => {
      deliveries.findDeliveryIdsByUserIds.mockResolvedValue([]);
      await expect(service.vehiculoEnUso('u1', 'd1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('legajoDelVehiculoEn', () => {
    it('es el legajo del chofer que lo tenía en uso en ese instante', async () => {
      assignments.choferDelVehiculoEn.mockResolvedValue('dl1');
      deliveries.findOne.mockResolvedValue({ userId: 'u1' });
      employees.findByUserIdEnDistribuidora.mockResolvedValue({
        employeeId: 'e1',
      });
      await expect(
        service.legajoDelVehiculoEn('c1', 'd1', new Date()),
      ).resolves.toBe('e1');
    });

    it('si nadie lo tenía, null', async () => {
      assignments.choferDelVehiculoEn.mockResolvedValue(null);
      await expect(
        service.legajoDelVehiculoEn('c1', 'd1', new Date()),
      ).resolves.toBeNull();
    });

    it('si el chofer ya no existe o no tiene legajo vigente, null', async () => {
      assignments.choferDelVehiculoEn.mockResolvedValue('dl1');
      deliveries.findOne.mockRejectedValue(new NotFoundException());
      await expect(
        service.legajoDelVehiculoEn('c1', 'd1', new Date()),
      ).resolves.toBeNull();

      deliveries.findOne.mockResolvedValue({ userId: 'u1' });
      employees.findByUserIdEnDistribuidora.mockResolvedValue(null);
      await expect(
        service.legajoDelVehiculoEn('c1', 'd1', new Date()),
      ).resolves.toBeNull();
    });
  });

  it('legajoDe devuelve el id o null', async () => {
    employees.findByUserIdEnDistribuidora.mockResolvedValue({
      employeeId: 'e1',
    });
    await expect(service.legajoDe('u1', 'd1')).resolves.toBe('e1');
    employees.findByUserIdEnDistribuidora.mockResolvedValue(null);
    await expect(service.legajoDe('u1', 'd1')).resolves.toBeNull();
  });

  it('assertLegajoDeLaDistribuidora delega en la búsqueda acotada (404 si es ajeno)', async () => {
    employees.findOne.mockRejectedValue(new NotFoundException());
    await expect(
      service.assertLegajoDeLaDistribuidora('e1', 'd1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(employees.findOne).toHaveBeenCalledWith('e1', 'd1');
  });
});
