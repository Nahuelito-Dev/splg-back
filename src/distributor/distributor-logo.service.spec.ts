import { NotFoundException } from '@nestjs/common';
import { DistributorLogoService } from './distributor-logo.service';
import type { DistributorService } from './distributor.service';
import type { EntityPhotoService } from '../s3/entity-photo.service';

describe('DistributorLogoService', () => {
  let distribuidoras: { findOne: jest.Mock };
  let fotos: {
    guardar: jest.Mock;
    quitar: jest.Mock;
    firmar: jest.Mock;
    enlace: jest.Mock;
  };
  let servicio: DistributorLogoService;

  beforeEach(() => {
    distribuidoras = {
      findOne: jest.fn().mockResolvedValue({
        distributorId: 'd1',
        logoKey: null,
        logoUrl: 'https://viejo.example/logo.png',
      }),
    };
    fotos = {
      guardar: jest.fn().mockResolvedValue(undefined),
      quitar: jest.fn().mockResolvedValue(undefined),
      firmar: jest.fn().mockResolvedValue(undefined),
      enlace: jest.fn().mockResolvedValue({ kind: 'none' }),
    };
    servicio = new DistributorLogoService(
      distribuidoras as unknown as DistributorService,
      fotos as unknown as EntityPhotoService,
    );
  });

  it('el admin sube el logo de la suya', async () => {
    await servicio.subir('d1', 'd1', undefined);
    expect(fotos.guardar).toHaveBeenCalledWith(
      expect.objectContaining({ keyProp: 'logoKey' }),
      'd1',
      undefined,
      'distributors/d1/logo',
    );
  });

  it('el admin de otra distribuidora recibe 404 sin tocar nada', async () => {
    await expect(servicio.subir('d1', 'd2', undefined)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(servicio.quitar('d1', 'd2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(servicio.enlace('d1', 'd2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(fotos.guardar).not.toHaveBeenCalled();
    expect(fotos.quitar).not.toHaveBeenCalled();
  });

  it('el super admin (sin alcance) puede con cualquiera', async () => {
    await servicio.quitar('d1', null);
    expect(fotos.quitar).toHaveBeenCalled();
  });

  it('el enlace usa sólo la key de S3, nunca el logo_url de texto', async () => {
    await servicio.enlace('d1', 'd1');
    expect(fotos.enlace).toHaveBeenCalledWith(null);
  });
});
