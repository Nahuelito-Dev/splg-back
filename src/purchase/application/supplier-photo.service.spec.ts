import { NotFoundException } from '@nestjs/common';
import { SupplierPhotoService } from './supplier-photo.service';
import type { SupplierService } from './supplier.service';
import type { EntityPhotoService } from '../../s3/entity-photo.service';

describe('SupplierPhotoService', () => {
  let buscar: { findOne: jest.Mock };
  let fotos: { guardar: jest.Mock; quitar: jest.Mock; enlace: jest.Mock };
  let servicio: SupplierPhotoService;
  const firmada = { url: 'https://s3/firmada', expiresAt: new Date(0) };

  beforeEach(() => {
    buscar = {
      findOne: jest
        .fn()
        .mockResolvedValue({ supplierId: 'x1', photoKey: null }),
    };
    fotos = {
      guardar: jest.fn().mockResolvedValue(undefined),
      quitar: jest.fn().mockResolvedValue(undefined),
      enlace: jest.fn().mockResolvedValue({ kind: 'none' }),
    };
    servicio = new SupplierPhotoService(
      buscar as unknown as SupplierService,
      fotos as unknown as EntityPhotoService,
    );
  });

  it('subir guarda la foto en la carpeta de la distribuidora y devuelve el enlace vigente', async () => {
    fotos.enlace.mockResolvedValue({ kind: 'stored', signed: firmada });
    const file = { size: 1 } as Express.Multer.File;
    const enlace = await servicio.subir('x1', 'd1', file);
    expect(fotos.guardar).toHaveBeenCalledWith(
      expect.objectContaining({ idProp: 'supplierId', keyProp: 'photoKey' }),
      'x1',
      file,
      'suppliers/d1/x1',
    );
    expect(enlace).toEqual({ kind: 'stored', signed: firmada });
  });

  it('una de otra distribuidora es 404 y no toca S3 ni la base de fotos', async () => {
    buscar.findOne.mockRejectedValue(new NotFoundException());
    await expect(servicio.subir('x1', 'd2', undefined)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(servicio.quitar('x1', 'd2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(servicio.enlace('x1', 'd2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(fotos.guardar).not.toHaveBeenCalled();
    expect(fotos.quitar).not.toHaveBeenCalled();
    expect(fotos.enlace).not.toHaveBeenCalled();
  });

  it('quitar limpia la clave y el enlace queda sin foto', async () => {
    const enlace = await servicio.quitar('x1', 'd1');
    expect(fotos.quitar).toHaveBeenCalledWith(
      expect.objectContaining({ idProp: 'supplierId', keyProp: 'photoKey' }),
      'x1',
    );
    expect(enlace).toEqual({ kind: 'none' });
  });

  it('el enlace firma la clave vigente y sin foto da none', async () => {
    buscar.findOne.mockResolvedValue({
      supplierId: 'x1',
      photoKey: 'suppliers/d1/x1/a.png',
    });
    await servicio.enlace('x1', 'd1');
    expect(fotos.enlace).toHaveBeenCalledWith('suppliers/d1/x1/a.png');
  });
});
