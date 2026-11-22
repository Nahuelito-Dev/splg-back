import type { DataSource } from 'typeorm';
import { EntityPhotoService } from '../../s3/entity-photo.service';
import type { S3CleanupService } from '../../s3/s3-cleanup.service';
import type { S3Service } from '../../s3/s3.service';
import { SupplierPhotoService } from '../application/supplier-photo.service';
import type { SupplierService } from '../application/supplier.service';
import type { PurchaseQueryService } from '../application/purchase-query.service';
import type { Supplier } from '../entities/supplier.entity';
import { SupplierController } from './supplier.controller';

const proveedor = (id: string, photoKey: string | null): Supplier =>
  ({
    supplierId: id,
    businessName: `Proveedor ${id}`,
    cuit: '30715123456',
    kind: 'other',
    contactName: null,
    phone: null,
    email: null,
    address: null,
    paymentTermsDays: null,
    isActive: true,
    photoKey,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as unknown as Supplier;

describe('SupplierController · photoUrl en lista y ficha', () => {
  let suppliers: {
    findAll: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  let storage: { getSignedDownload: jest.Mock };
  let controller: SupplierController;

  beforeEach(() => {
    suppliers = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };
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
    controller = new SupplierController(
      suppliers as unknown as SupplierService,
      {} as unknown as PurchaseQueryService,
      new SupplierPhotoService({} as unknown as SupplierService, fotos),
    );
  });

  it('GET /suppliers: cada fila lleva su URL firmada o null, con una firma por foto', async () => {
    suppliers.findAll.mockResolvedValue({
      data: [proveedor('s1', 'suppliers/d1/s1/a.jpg'), proveedor('s2', null)],
      total: 2,
    });
    const r = await controller.findAll({}, 'd1');
    expect(r.data.map((s) => s.photoUrl)).toEqual([
      'https://s3.test/suppliers/d1/s1/a.jpg',
      null,
    ]);
    expect(storage.getSignedDownload).toHaveBeenCalledTimes(1);
  });

  it('GET /suppliers con la firma caída: photoUrl null y la lista sigue igual', async () => {
    suppliers.findAll.mockResolvedValue({
      data: [proveedor('s1', 'k.jpg')],
      total: 1,
    });
    storage.getSignedDownload.mockRejectedValue(new Error('S3 caído'));
    const r = await controller.findAll({}, 'd1');
    expect(r.total).toBe(1);
    expect(r.data[0].photoUrl).toBeNull();
    expect(r.data[0].businessName).toBe('Proveedor s1');
  });

  it('GET /suppliers/:id con foto', async () => {
    suppliers.findOne.mockResolvedValue(
      proveedor('s1', 'suppliers/d1/s1/a.jpg'),
    );
    const r = await controller.findOne('s1', 'd1');
    expect(r.photoUrl).toBe('https://s3.test/suppliers/d1/s1/a.jpg');
  });

  it('GET /suppliers/:id sin foto', async () => {
    suppliers.findOne.mockResolvedValue(proveedor('s1', null));
    const r = await controller.findOne('s1', 'd1');
    expect(r.photoUrl).toBeNull();
    expect(storage.getSignedDownload).not.toHaveBeenCalled();
  });

  it('POST y PATCH devuelven la misma ficha con photoUrl', async () => {
    suppliers.create.mockResolvedValue(proveedor('s1', null));
    suppliers.update.mockResolvedValue(proveedor('s1', 'k.jpg'));
    const creado = await controller.create({} as never, 'd1');
    const editado = await controller.update('s1', {} as never, 'd1');
    expect(creado.photoUrl).toBeNull();
    expect(editado.photoUrl).toBe('https://s3.test/k.jpg');
  });
});
