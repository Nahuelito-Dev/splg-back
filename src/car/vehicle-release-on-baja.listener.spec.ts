import { VehicleReleaseOnBajaListener } from './vehicle-release-on-baja.listener';
import { VehicleAssignmentService } from './vehicle-assignment.service';
import { EntityManager } from 'typeorm';
import { ChoferDadoDeBajaEvent } from '../delivery/events/chofer-dado-de-baja.event';

describe('VehicleReleaseOnBajaListener', () => {
  it('libera el vehículo en uso del chofer dado de baja', async () => {
    const vehicleAssignments = {
      liberarSiTieneUno: jest.fn().mockResolvedValue(undefined),
    };
    const listener = new VehicleReleaseOnBajaListener(
      vehicleAssignments as unknown as VehicleAssignmentService,
    );

    const manager = {} as EntityManager;
    await listener.handle(new ChoferDadoDeBajaEvent('dl1', manager));

    expect(vehicleAssignments.liberarSiTieneUno).toHaveBeenCalledWith(
      'dl1',
      manager,
    );
  });
});
