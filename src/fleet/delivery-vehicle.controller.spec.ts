import { NotFoundException } from '@nestjs/common';
import { DeliveryVehicleController } from './delivery-vehicle.controller';
import { VehicleAssignmentService } from '../car/vehicle-assignment.service';
import { FleetTaskService } from './fleet-task.service';
import { DeliveryService } from '../delivery/delivery.service';
import { CarPhotoService } from '../car/car-photo.service';
import { Car } from '../car/entities/car.entity';

/** Firma como el real: la URL sale de la clave, y sin clave es null. */
const fotosDeVehiculosFalsas = () => ({
  firmar: jest.fn((cars: Car | readonly Car[]) => {
    for (const c of Array.isArray(cars) ? (cars as Car[]) : [cars as Car]) {
      c.photoSignedUrl = c.photoKey ? `https://s3.test/${c.photoKey}` : null;
    }
    return Promise.resolve();
  }),
});

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
  let fotos: ReturnType<typeof fotosDeVehiculosFalsas>;

  beforeEach(() => {
    fotos = fotosDeVehiculosFalsas();
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
      fotos as unknown as CarPhotoService,
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

describe('DeliveryVehicleController · foto del vehículo', () => {
  const auto = (id: string, photoKey: string | null) =>
    ({ carId: id, carPatent: id, photoKey }) as Car;
  const asignacion = (id: string, car: Car) => ({
    assignmentId: `a-${id}`,
    deliveryId: 'dl1',
    carId: car.carId,
    car,
    assignedAt: new Date('2026-10-01T00:00:00.000Z'),
    releasedAt: null,
    note: null,
  });
  let vehicleAssignments: {
    ponerEnUso: jest.Mock;
    vehiculoEnUso: jest.Mock;
    historialDelChofer: jest.Mock;
    assertChoferDelTenant: jest.Mock;
  };
  let fotos: ReturnType<typeof fotosDeVehiculosFalsas>;
  let controller: DeliveryVehicleController;

  beforeEach(() => {
    vehicleAssignments = {
      ponerEnUso: jest.fn(),
      vehiculoEnUso: jest.fn(),
      historialDelChofer: jest.fn(),
      assertChoferDelTenant: jest.fn().mockResolvedValue(undefined),
    };
    fotos = fotosDeVehiculosFalsas();
    controller = new DeliveryVehicleController(
      vehicleAssignments as unknown as VehicleAssignmentService,
      {
        assertVehiculoHabilitado: jest.fn().mockResolvedValue(undefined),
        motivosDeInhabilitacionDeVehiculo: jest.fn().mockResolvedValue([]),
      } as unknown as FleetTaskService,
      {
        findOneByUserId: jest.fn().mockResolvedValue({ deliveryId: 'dl1' }),
      } as unknown as DeliveryService,
      fotos as unknown as CarPhotoService,
    );
  });

  it('GET /delivery/:id/vehicle: el vehículo en uso trae photoUrl firmada', async () => {
    vehicleAssignments.vehiculoEnUso.mockResolvedValue(
      asignacion('1', auto('c1', 'cars/d1/c1/x.jpg')),
    );
    const r = await controller.vehiculoDelChofer('dl1', 'd1');
    expect(r?.photoUrl).toBe('https://s3.test/cars/d1/c1/x.jpg');
  });

  it('GET /delivery/:id/vehicle: sin foto, photoUrl es null y el resto sigue igual', async () => {
    vehicleAssignments.vehiculoEnUso.mockResolvedValue(
      asignacion('1', auto('c1', null)),
    );
    const r = await controller.vehiculoDelChofer('dl1', 'd1');
    expect(r).toMatchObject({ carId: 'c1', carPatent: 'c1', photoUrl: null });
  });

  it('GET /delivery/me/vehicle: también trae photoUrl', async () => {
    vehicleAssignments.vehiculoEnUso.mockResolvedValue(
      asignacion('1', auto('c1', 'k.jpg')),
    );
    const r = await controller.miVehiculo({ user_id: 'u1' } as never, 'd1');
    expect(r?.photoUrl).toBe('https://s3.test/k.jpg');
  });

  it('GET /delivery/:id/vehicle sin vehículo en uso: null y no firma nada', async () => {
    vehicleAssignments.vehiculoEnUso.mockResolvedValue(null);
    await expect(controller.vehiculoDelChofer('dl1', 'd1')).resolves.toBeNull();
    expect(fotos.firmar).not.toHaveBeenCalled();
  });

  it('PUT /delivery/:id/vehicle: la respuesta trae photoUrl del auto asignado', async () => {
    vehicleAssignments.ponerEnUso.mockResolvedValue(
      asignacion('1', auto('c1', 'k.jpg')),
    );
    const r = await controller.ponerEnUso(
      'dl1',
      { carId: 'c1' },
      { user_id: 'admin1' } as never,
      'd1',
    );
    expect(r.photoUrl).toBe('https://s3.test/k.jpg');
  });

  it('GET /delivery/:id/vehicle-history: firma los autos de la página de una sola vez y cada renglón lleva su foto', async () => {
    vehicleAssignments.historialDelChofer.mockResolvedValue([
      [
        asignacion('1', auto('c1', 'a.jpg')),
        asignacion('2', auto('c2', null)),
        asignacion('3', auto('c3', 'c.jpg')),
      ],
      3,
    ]);
    const res = { setHeader: jest.fn() };
    const r = await controller.historial('dl1', {}, res as never, 'd1');
    expect(r.map((x) => x.photoUrl)).toEqual([
      'https://s3.test/a.jpg',
      null,
      'https://s3.test/c.jpg',
    ]);
    expect(fotos.firmar).toHaveBeenCalledTimes(1);
  });
});
