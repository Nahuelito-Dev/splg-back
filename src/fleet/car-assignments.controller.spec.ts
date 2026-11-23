import { CarAssignmentsController } from './car-assignments.controller';
import { VehicleAssignmentService } from '../car/vehicle-assignment.service';
import { CarPhotoService } from '../car/car-photo.service';
import { Car } from '../car/entities/car.entity';

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

const armar = (filas: ReturnType<typeof asignacion>[]) => {
  const firmar = jest.fn((cars: Car[]) => {
    for (const c of cars) {
      c.photoSignedUrl = c.photoKey ? `https://s3.test/${c.photoKey}` : null;
    }
    return Promise.resolve();
  });
  const controller = new CarAssignmentsController(
    {
      historialDelVehiculo: jest.fn().mockResolvedValue([filas, filas.length]),
    } as unknown as VehicleAssignmentService,
    { firmar } as unknown as CarPhotoService,
  );
  return { controller, firmar };
};

const res = { setHeader: jest.fn() } as never;

describe('CarAssignmentsController · foto del vehículo', () => {
  it('GET /car/:id/assignments: cada renglón lleva photoUrl firmada y se firma una sola vez', async () => {
    const { controller, firmar } = armar([
      asignacion('1', auto('c1', 'a.jpg')),
      asignacion('2', auto('c1', 'a.jpg')),
    ]);
    const r = await controller.historial('c1', {}, res, 'd1');
    expect(r.map((x) => x.photoUrl)).toEqual([
      'https://s3.test/a.jpg',
      'https://s3.test/a.jpg',
    ]);
    expect(firmar).toHaveBeenCalledTimes(1);
  });

  it('un auto sin foto sale con photoUrl null', async () => {
    const { controller } = armar([asignacion('1', auto('c1', null))]);
    const r = await controller.historial('c1', {}, res, 'd1');
    expect(r[0].photoUrl).toBeNull();
  });
});
