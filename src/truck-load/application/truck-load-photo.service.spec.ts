import { TruckLoadPhotoService } from './truck-load-photo.service';
import type { Repository } from 'typeorm';
import type { TruckLoad } from '../entities/truck-load.entity';
import { CargaNoEncontradaError } from '../domain/errors/truck-load.errors';
import type { EntityPhotoService } from '../../s3/entity-photo.service';

describe('TruckLoadPhotoService', () => {
  let buscar: { findOne: jest.Mock };
  let fotos: { guardar: jest.Mock; quitar: jest.Mock; enlace: jest.Mock };
  let servicio: TruckLoadPhotoService;
  const firmada = { url: 'https://s3/firmada', expiresAt: new Date(0) };

  beforeEach(() => {
    buscar = {
      findOne: jest
        .fn()
        .mockResolvedValue({ loadId: 'x1', photoKey: null, deliveryId: 'ch1' }),
    };
    fotos = {
      guardar: jest.fn().mockResolvedValue(undefined),
      quitar: jest.fn().mockResolvedValue(undefined),
      enlace: jest.fn().mockResolvedValue({ kind: 'none' }),
    };
    servicio = new TruckLoadPhotoService(
      buscar as unknown as Repository<TruckLoad>,
      fotos as unknown as EntityPhotoService,
    );
  });

  it('subir guarda la foto en la carpeta de la distribuidora y devuelve el enlace vigente', async () => {
    fotos.enlace.mockResolvedValue({ kind: 'stored', signed: firmada });
    const file = { size: 1 } as Express.Multer.File;
    const enlace = await servicio.subir('x1', 'd1', file);
    expect(fotos.guardar).toHaveBeenCalledWith(
      expect.objectContaining({ idProp: 'loadId', keyProp: 'photoKey' }),
      'x1',
      file,
      'truck-loads/d1/x1',
    );
    expect(enlace).toEqual({ kind: 'stored', signed: firmada });
  });

  it('una de otra distribuidora es 404 y no toca S3 ni la base de fotos', async () => {
    buscar.findOne.mockResolvedValue(null);
    await expect(servicio.subir('x1', 'd2', undefined)).rejects.toBeInstanceOf(
      CargaNoEncontradaError,
    );
    await expect(servicio.quitar('x1', 'd2')).rejects.toBeInstanceOf(
      CargaNoEncontradaError,
    );
    await expect(servicio.enlace('x1', 'd2')).rejects.toBeInstanceOf(
      CargaNoEncontradaError,
    );
    expect(fotos.guardar).not.toHaveBeenCalled();
    expect(fotos.quitar).not.toHaveBeenCalled();
    expect(fotos.enlace).not.toHaveBeenCalled();
  });

  it('quitar limpia la clave y el enlace queda sin foto', async () => {
    const enlace = await servicio.quitar('x1', 'd1');
    expect(fotos.quitar).toHaveBeenCalledWith(
      expect.objectContaining({ idProp: 'loadId', keyProp: 'photoKey' }),
      'x1',
    );
    expect(enlace).toEqual({ kind: 'none' });
  });

  it('el enlace firma la clave vigente y sin foto da none', async () => {
    buscar.findOne.mockResolvedValue({
      loadId: 'x1',
      photoKey: 'truck-loads/d1/x1/a.png',
      deliveryId: 'ch1',
    });
    await servicio.enlace('x1', 'd1');
    expect(fotos.enlace).toHaveBeenCalledWith('truck-loads/d1/x1/a.png');
  });

  it('el chofer sólo ve la foto de sus cargas: la de otro chofer es 404', async () => {
    await servicio.enlace('x1', 'd1', 'ch1');
    expect(fotos.enlace).toHaveBeenCalledTimes(1);
    await expect(servicio.enlace('x1', 'd1', 'ch2')).rejects.toBeInstanceOf(
      CargaNoEncontradaError,
    );
    expect(fotos.enlace).toHaveBeenCalledTimes(1);
  });

  it('busca la carga siempre acotada por la distribuidora', async () => {
    await servicio.enlace('x1', 'd1');
    expect(buscar.findOne).toHaveBeenCalledWith({
      where: { loadId: 'x1', distributorId: 'd1' },
    });
  });
});
