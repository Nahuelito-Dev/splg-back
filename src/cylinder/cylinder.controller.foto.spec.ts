import type { DataSource } from 'typeorm';
import type { GasCylinder } from '../gascylinder/entities/gascylinder.entity';
import { EntityPhotoService } from '../s3/entity-photo.service';
import type { S3CleanupService } from '../s3/s3-cleanup.service';
import type { S3Service } from '../s3/s3.service';
import { CylinderController } from './cylinder.controller';
import { CylinderPhotoService } from './cylinder-photo.service';
import type { CylinderService } from './cylinder.service';
import type { CylinderVigenciaService } from './cylinder-vigencia.service';
import { Cylinder, CylinderState } from './entities/cylinder.entity';

const envase = (
  id: string,
  photoKey: string | null,
  producto: { photoKey: string | null } | null = null,
): Cylinder =>
  ({
    cylinderId: id,
    distributorId: 'd1',
    serial: `SN-${id}`,
    gasCylinderId: producto ? 'g1' : null,
    state: CylinderState.IN_DEPOT,
    currentCustomerId: null,
    currentOrderId: null,
    deposit: 0,
    gasCylinder: producto
      ? ({
          gasCylinderId: 'g1',
          type: '10kg',
          weight: 10,
          photoKey: producto.photoKey,
        } as unknown as GasCylinder)
      : null,
    currentCustomer: null,
    manufacturedAt: null,
    lastInspectionAt: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    photoKey,
  }) as unknown as Cylinder;

describe('CylinderController · photoUrl del envase y de su producto', () => {
  let service: {
    findAll: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
  };
  let storage: { getSignedDownload: jest.Mock };
  let controller: CylinderController;

  beforeEach(() => {
    service = { findAll: jest.fn(), findOne: jest.fn(), create: jest.fn() };
    storage = {
      getSignedDownload: jest.fn((key: string) =>
        Promise.resolve({ url: `https://s3.test/${key}`, expiresAt: 'x' }),
      ),
    };
    const fotos = new EntityPhotoService(
      {} as unknown as DataSource,
      storage as unknown as S3Service,
      {} as unknown as S3CleanupService,
    );
    controller = new CylinderController(
      service as unknown as CylinderService,
      {} as unknown as CylinderVigenciaService,
      new CylinderPhotoService(service as unknown as CylinderService, fotos),
    );
  });

  it('GET /cylinders: cada envase lleva su foto y la del producto anidado, o null', async () => {
    service.findAll.mockResolvedValue([
      [
        envase('c1', 'cylinders/d1/c1/a.jpg', { photoKey: 'gc/d1/g1/p.jpg' }),
        envase('c2', null, { photoKey: null }),
        envase('c3', null, null),
      ],
      3,
    ]);
    const res = { setHeader: jest.fn() };
    const r = await controller.findAll({} as never, res as never, 'd1');
    expect(r.map((c) => c.photoUrl)).toEqual([
      'https://s3.test/cylinders/d1/c1/a.jpg',
      null,
      null,
    ]);
    expect(r.map((c) => c.gas_cylinder?.photoUrl ?? null)).toEqual([
      'https://s3.test/gc/d1/g1/p.jpg',
      null,
      null,
    ]);
  });

  it('GET /cylinders con la firma caída: photoUrl null y la lista sigue', async () => {
    service.findAll.mockResolvedValue([
      [envase('c1', 'k.jpg', { photoKey: 'p.jpg' })],
      1,
    ]);
    storage.getSignedDownload.mockRejectedValue(new Error('S3 caído'));
    const res = { setHeader: jest.fn() };
    const r = await controller.findAll({} as never, res as never, 'd1');
    expect(r).toHaveLength(1);
    expect(r[0].photoUrl).toBeNull();
    expect(r[0].gas_cylinder?.photoUrl).toBeNull();
    expect(r[0].serial).toBe('SN-c1');
  });

  it('GET /cylinders/:id con foto y producto con foto', async () => {
    service.findOne.mockResolvedValue(
      envase('c1', 'cylinders/d1/c1/a.jpg', { photoKey: 'gc/d1/g1/p.jpg' }),
    );
    const r = await controller.findOne('c1', 'd1');
    expect(r.photoUrl).toBe('https://s3.test/cylinders/d1/c1/a.jpg');
    expect(r.gas_cylinder?.photoUrl).toBe('https://s3.test/gc/d1/g1/p.jpg');
  });

  it('GET /cylinders/:id sin foto ni producto', async () => {
    service.findOne.mockResolvedValue(envase('c1', null, null));
    const r = await controller.findOne('c1', 'd1');
    expect(r.photoUrl).toBeNull();
    expect(r.gas_cylinder).toBeNull();
    expect(storage.getSignedDownload).not.toHaveBeenCalled();
  });

  it('POST /cylinders devuelve el alta con photoUrl null', async () => {
    service.create.mockResolvedValue(envase('c1', null, null));
    const r = await controller.create({} as never, 'd1');
    expect(r.photoUrl).toBeNull();
  });
});
