import { NotFoundException } from '@nestjs/common';
import { DeliveryVehicleController } from './delivery-vehicle.controller';
import { VehicleAssignmentService } from '../car/vehicle-assignment.service';
import { FleetTaskService } from './fleet-task.service';
import { DeliveryService } from '../delivery/delivery.service';

/**
 * `PUT /delivery/:id/vehicle` (decisión de nahue, 30/09). El caso crítico de
 * seguridad (CONVENCIONES §4): un chofer de OTRA distribuidora tiene que
 * cortar con 404 SIN que se llegue a consultar la flota del vehículo — si
 * no, un vehículo inhabilitado filtraría el motivo (400 con el detalle de
 * qué venció) antes de confirmar que el chofer es de este tenant. Y el
 * camino exitoso de la revisión: la respuesta se arma del resultado de
 * `ponerEnUso` (que ya trae `car`), sin otra consulta a `vehiculoEnUso`.
 */
describe('DeliveryVehicleController · ponerEnUso', () => {
  let controller: DeliveryVehicleController;
  let vehicleAssignments: {
    assertChoferDelTenant: jest.Mock;
    ponerEnUso: jest.Mock;
    vehiculoEnUso: jest.Mock;
  };
  let fleetTasks: {
    assertVehiculoHabilitado: jest.Mock;
    motivosDeInhabilitacionDeVehiculo: jest.Mock;
  };

  beforeEach(() => {
    vehicleAssignments = {
      assertChoferDelTenant: jest.fn(),
      ponerEnUso: jest.fn(),
      vehiculoEnUso: jest.fn(),
    };
    fleetTasks = {
      assertVehiculoHabilitado: jest.fn(),
      motivosDeInhabilitacionDeVehiculo: jest.fn().mockResolvedValue([]),
    };

    controller = new DeliveryVehicleController(
      vehicleAssignments as unknown as VehicleAssignmentService,
      fleetTasks as unknown as FleetTaskService,
      {} as DeliveryService,
    );
  });

  it('un chofer de otra distribuidora es 404 y NI SIQUIERA consulta la flota del vehículo', async () => {
    vehicleAssignments.assertChoferDelTenant.mockRejectedValue(
      new NotFoundException('Chofer dl1 no encontrado'),
    );

    await expect(
      controller.ponerEnUso(
        'dl1',
        { carId: 'c1' },
        { user_id: 'admin1' } as never,
        'd1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(fleetTasks.assertVehiculoHabilitado).not.toHaveBeenCalled();
    expect(vehicleAssignments.ponerEnUso).not.toHaveBeenCalled();
  });

  it('un chofer del tenant pero con el vehículo inhabilitado es 400 (ya pasó el chequeo de pertenencia)', async () => {
    vehicleAssignments.assertChoferDelTenant.mockResolvedValue(undefined);
    fleetTasks.assertVehiculoHabilitado.mockRejectedValue(
      new Error('No se puede asignar: VTV: venció el 01/01/2020.'),
    );

    await expect(
      controller.ponerEnUso(
        'dl1',
        { carId: 'c1' },
        { user_id: 'admin1' } as never,
        'd1',
      ),
    ).rejects.toThrow('No se puede asignar: VTV: venció el 01/01/2020.');

    expect(vehicleAssignments.assertChoferDelTenant).toHaveBeenCalledWith(
      'dl1',
      'd1',
    );
    expect(vehicleAssignments.ponerEnUso).not.toHaveBeenCalled();
  });

  it('éxito: arma la respuesta del resultado de `ponerEnUso`, sin otra consulta a `vehiculoEnUso`', async () => {
    vehicleAssignments.assertChoferDelTenant.mockResolvedValue(undefined);
    fleetTasks.assertVehiculoHabilitado.mockResolvedValue(undefined);
    vehicleAssignments.ponerEnUso.mockResolvedValue({
      deliveryId: 'dl1',
      carId: 'c1',
      car: { carPatent: 'AB123CD', carBrand: 'Honda', carModel: 'Wave' },
      assignedAt: new Date('2026-10-01T00:00:00.000Z'),
      note: null,
    });

    const resultado = await controller.ponerEnUso(
      'dl1',
      { carId: 'c1' },
      { user_id: 'admin1' } as never,
      'd1',
    );

    expect(resultado).toMatchObject({
      deliveryId: 'dl1',
      carId: 'c1',
      carPatent: 'AB123CD',
      isLocked: false,
    });
    expect(vehicleAssignments.vehiculoEnUso).not.toHaveBeenCalled();
  });
});
