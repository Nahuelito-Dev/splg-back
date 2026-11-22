import { BadRequestException } from '@nestjs/common';
import type {
  FilaDeActividad,
  PlatformMetricsRepository,
} from '../infrastructure/platform-metrics.repository';
import { PlatformActivityService } from './platform-activity.service';
import type { EntityPhotoService } from '../../s3/entity-photo.service';

/** Firma de mentira: la key con una marca, `null` si no hay foto. */
const urlDe = jest.fn((key: string | null | undefined) =>
  Promise.resolve(key ? `https://s3.test/${key}?firma` : null),
);
const fotos = { urlDe } as unknown as EntityPhotoService;

const fila = (total: number): FilaDeActividad => ({
  id: 'a1',
  at: new Date('2026-11-14T12:00:00Z'),
  kind: 'request',
  actor_user_id: 'u1',
  actor_name: 'Soporte',
  actor_photo_key: null,
  actor_role: 'super_admin',
  method: 'PATCH',
  resource: 'distributor',
  resource_id: 'd1',
  path: '/api/distributor/:id',
  distributor_id: 'd1',
  distributor_name: 'Alfa',
  result: 'success',
  status_code: 200,
  total,
});

function armar() {
  const repo = {
    actividad: jest.fn().mockResolvedValue([fila(7)]),
    totalDeActividad: jest.fn().mockResolvedValue(7),
  };
  return {
    service: new PlatformActivityService(
      repo as unknown as PlatformMetricsRepository,
      fotos,
    ),
    repo,
  };
}

describe('PlatformActivityService', () => {
  it('pasa los filtros convertidos y mapea las filas con el total', async () => {
    const { service, repo } = armar();
    const r = await service.listar({
      from: '2026-11-01T00:00:00-03:00',
      to: '2026-11-15T00:00:00-03:00',
      actorUserId: 'u1',
      distributorId: 'd1',
      limit: 20,
      offset: 0,
    });
    expect(repo.actividad).toHaveBeenCalledWith({
      desde: new Date('2026-11-01T03:00:00Z'),
      hasta: new Date('2026-11-15T03:00:00Z'),
      actorUserId: 'u1',
      distributorId: 'd1',
      limit: 20,
      offset: 0,
    });
    expect(r.total).toBe(7);
    expect(r.items[0]).toEqual({
      id: 'a1',
      at: new Date('2026-11-14T12:00:00Z'),
      kind: 'request',
      actorUserId: 'u1',
      actorName: 'Soporte',
      actorPhotoUrl: null,
      actorRole: 'super_admin',
      method: 'PATCH',
      resource: 'distributor',
      resourceId: 'd1',
      path: '/api/distributor/:id',
      distributorId: 'd1',
      distributorName: 'Alfa',
      result: 'success',
      statusCode: 200,
    });
    expect(repo.totalDeActividad).not.toHaveBeenCalled();
  });

  it('la foto del actor: firmada si tiene, null si no tiene o no hay actor; una firma por foto aunque el actor se repita', async () => {
    urlDe.mockClear();
    const { service, repo } = armar();
    repo.actividad.mockResolvedValue([
      { ...fila(4), id: 'a1', actor_photo_key: 'users/u1/a.jpg' },
      { ...fila(4), id: 'a2', actor_photo_key: 'users/u1/a.jpg' },
      { ...fila(4), id: 'a3', actor_user_id: 'u2', actor_photo_key: null },
      {
        ...fila(4),
        id: 'a4',
        actor_user_id: null,
        actor_name: null,
        actor_photo_key: null,
      },
    ]);
    const r = await service.listar({ limit: 20, offset: 0 });
    expect(r.items.map((i) => i.actorPhotoUrl)).toEqual([
      'https://s3.test/users/u1/a.jpg?firma',
      'https://s3.test/users/u1/a.jpg?firma',
      null,
      null,
    ]);
    expect(urlDe).toHaveBeenCalledTimes(1);
    // La key no sale en la respuesta.
    expect(JSON.stringify(r)).not.toContain('actor_photo_key');
  });

  it('sin filtros pasa nulos', async () => {
    const { service, repo } = armar();
    await service.listar({ limit: 50, offset: 0 });
    expect(repo.actividad).toHaveBeenCalledWith(
      expect.objectContaining({
        desde: null,
        hasta: null,
        actorUserId: null,
        distributorId: null,
      }),
    );
  });

  it('una página vacía más allá del final pide el total aparte; la primera vacía es 0', async () => {
    const { service, repo } = armar();
    repo.actividad.mockResolvedValue([]);
    expect((await service.listar({ limit: 10, offset: 100 })).total).toBe(7);
    expect((await service.listar({ limit: 10, offset: 0 })).total).toBe(0);
    expect(repo.totalDeActividad).toHaveBeenCalledTimes(1);
  });

  it('«desde» posterior a «hasta» es 400 sin consultar', async () => {
    const { service, repo } = armar();
    await expect(
      service.listar({
        from: '2026-11-10T00:00:00Z',
        to: '2026-11-01T00:00:00Z',
        limit: 10,
        offset: 0,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.actividad).not.toHaveBeenCalled();
  });
});
