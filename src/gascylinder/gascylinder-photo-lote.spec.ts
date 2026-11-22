import type { Repository } from 'typeorm';
import type { EntityPhotoService } from '../s3/entity-photo.service';
import type { GasCylinder } from './entities/gascylinder.entity';
import type { GasCylinderService } from './gascylinder.service';
import { GasCylinderPhotoService } from './gascylinder-photo.service';

const producto = (gasCylinderId: string, photoKey: string | null) =>
  ({ gasCylinderId, photoKey }) as GasCylinder;

describe('GasCylinderPhotoService.urlsPorId · fotos de varios productos', () => {
  let repo: { find: jest.Mock };
  let fotos: { urlDe: jest.Mock };
  let service: GasCylinderPhotoService;

  beforeEach(() => {
    repo = { find: jest.fn().mockResolvedValue([]) };
    fotos = {
      urlDe: jest.fn((key: string | null) =>
        Promise.resolve(key ? `https://s3.test/${key}` : null),
      ),
    };
    service = new GasCylinderPhotoService(
      {} as unknown as GasCylinderService,
      fotos as unknown as EntityPhotoService,
      repo as unknown as Repository<GasCylinder>,
    );
  });

  it('con foto: la URL firmada del producto', async () => {
    repo.find.mockResolvedValue([producto('g1', 'gascylinders/d1/g1/x.jpg')]);
    const urls = await service.urlsPorId('d1', ['g1']);
    expect(urls.get('g1')).toBe('https://s3.test/gascylinders/d1/g1/x.jpg');
  });

  it('sin foto: null', async () => {
    repo.find.mockResolvedValue([producto('g1', null)]);
    const urls = await service.urlsPorId('d1', ['g1']);
    expect(urls.get('g1')).toBeNull();
  });

  it('firma caída: null y no rompe', async () => {
    repo.find.mockResolvedValue([producto('g1', 'k.jpg')]);
    fotos.urlDe.mockResolvedValueOnce(null);
    const urls = await service.urlsPorId('d1', ['g1']);
    expect(urls.get('g1')).toBeNull();
  });

  it('una sola lectura por ids sin repetir, filtrada por la distribuidora', async () => {
    await service.urlsPorId('d1', ['g1', 'g2', 'g1']);
    expect(repo.find).toHaveBeenCalledTimes(1);
    const llamadas = repo.find.mock.calls as unknown[][];
    const arg = llamadas[0][0] as {
      where: { distributorId: string; gasCylinderId: { value: string[] } };
    };
    expect(arg.where.distributorId).toBe('d1');
    expect(arg.where.gasCylinderId.value).toEqual(['g1', 'g2']);
  });

  it('sin ids no consulta la base', async () => {
    const urls = await service.urlsPorId('d1', []);
    expect(urls.size).toBe(0);
    expect(repo.find).not.toHaveBeenCalled();
  });
});
