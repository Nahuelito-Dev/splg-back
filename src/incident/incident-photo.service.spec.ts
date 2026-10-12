import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { IncidentPhotoService } from './incident-photo.service';
import type { IncidentService } from './incident.service';
import type { EntityPhotoService } from '../s3/entity-photo.service';
import { RoleType } from '../common/constants/role-type.enum';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';

const chofer = (id: string): AuthenticatedUser => ({
  user_id: id,
  email: `${id}@x`,
  role: RoleType.DELIVERY,
});
const admin: AuthenticatedUser = {
  user_id: 'a1',
  email: 'a@x',
  role: RoleType.ADMIN,
};

describe('IncidentPhotoService', () => {
  let incidents: { findOne: jest.Mock };
  let fotos: {
    guardar: jest.Mock;
    quitar: jest.Mock;
    firmar: jest.Mock;
    enlace: jest.Mock;
  };
  let servicio: IncidentPhotoService;

  beforeEach(() => {
    incidents = {
      findOne: jest.fn().mockResolvedValue({
        incidentId: 'i1',
        distributorId: 'd1',
        reportedBy: 'c1',
        status: 'open',
        photoKey: null,
        photoUrl: 'https://ext/x.jpg',
      }),
    };
    fotos = {
      guardar: jest.fn().mockResolvedValue(undefined),
      quitar: jest.fn().mockResolvedValue(undefined),
      firmar: jest.fn().mockResolvedValue(undefined),
      enlace: jest.fn().mockResolvedValue({ kind: 'none' }),
    };
    servicio = new IncidentPhotoService(
      incidents as unknown as IncidentService,
      fotos as unknown as EntityPhotoService,
    );
  });

  it('el chofer que la reportó la sube, bajo la carpeta de la distribuidora', async () => {
    await servicio.subir('i1', chofer('c1'), 'd1', undefined);
    expect(fotos.guardar).toHaveBeenCalledWith(
      expect.objectContaining({ keyProp: 'photoKey' }),
      'i1',
      undefined,
      'incidents/d1/i1',
      expect.any(Function),
    );
  });

  it('resuelta o descartada: 409 al subir y al quitar, sin tocar el bucket', async () => {
    for (const status of ['resolved', 'discarded']) {
      incidents.findOne.mockResolvedValue({
        incidentId: 'i1',
        distributorId: 'd1',
        reportedBy: 'c1',
        status,
        photoKey: 'incidents/d1/i1/a.png',
      });
      await expect(
        servicio.subir('i1', admin, 'd1', undefined),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(servicio.quitar('i1', admin, 'd1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    }
    expect(fotos.guardar).not.toHaveBeenCalled();
    expect(fotos.quitar).not.toHaveBeenCalled();
  });

  it('el control con la fila bloqueada también exige que esté abierta', async () => {
    await servicio.subir('i1', admin, 'd1', undefined);
    const verificar = (fotos.guardar.mock.calls[0] as unknown[])[4] as (
      fila: Record<string, unknown>,
    ) => void;
    expect(() => verificar({ status: 'open' })).not.toThrow();
    expect(() => verificar({ status: 'resolved' })).toThrow(ConflictException);
  });

  it('otro chofer recibe 403 y no toca nada, ni para subir, ni para quitar, ni para ver', async () => {
    await expect(
      servicio.subir('i1', chofer('c2'), 'd1', undefined),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      servicio.quitar('i1', chofer('c2'), 'd1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      servicio.enlace('i1', chofer('c2'), 'd1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(fotos.guardar).not.toHaveBeenCalled();
    expect(fotos.quitar).not.toHaveBeenCalled();
  });

  it('el admin de la distribuidora puede con cualquiera', async () => {
    await servicio.quitar('i1', admin, 'd1');
    expect(fotos.quitar).toHaveBeenCalled();
  });

  it('otra distribuidora: 404 del tenant, antes de cualquier subida', async () => {
    incidents.findOne.mockRejectedValue(new NotFoundException());
    await expect(
      servicio.subir('i1', admin, 'otra', undefined),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(incidents.findOne).toHaveBeenCalledWith('i1', 'otra');
    expect(fotos.guardar).not.toHaveBeenCalled();
  });

  it('el enlace usa sólo la key de S3, nunca la photo_url externa', async () => {
    await servicio.enlace('i1', admin, 'd1');
    expect(fotos.enlace).toHaveBeenCalledWith(null);
  });
});
