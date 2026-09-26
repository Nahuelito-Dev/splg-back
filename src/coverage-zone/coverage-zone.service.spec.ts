import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { CoverageZoneService } from './coverage-zone.service';
import { CoverageZone } from './entities/coverage-zone.entity';

/**
 * Una zona es un polígono con recargo. Sin zonas cargadas, la distribuidora
 * cubre todo; con zonas, una dirección está cubierta si cae en alguna activa, y
 * se cobra el menor recargo.
 */
describe('CoverageZoneService', () => {
  let service: CoverageZoneService;
  let repo: {
    create: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
    query: jest.Mock;
  };

  beforeEach(() => {
    repo = {
      create: jest.fn((z: Partial<CoverageZone>) => z),
      save: jest.fn((z: CoverageZone) => Promise.resolve(z)),
      count: jest.fn(),
      query: jest.fn(),
    };
    service = new CoverageZoneService(
      repo as unknown as Repository<CoverageZone>,
    );
  });

  it('cierra el anillo del polígono si viene abierto', async () => {
    const z = await service.create(
      {
        name: 'Centro',
        polygon: [
          [-55.9, -27.3],
          [-55.8, -27.3],
          [-55.8, -27.4],
        ],
      },
      'd1',
    );
    expect(z.area.coordinates[0]).toHaveLength(4);
    expect(z.area.coordinates[0][3]).toEqual([-55.9, -27.3]);
  });

  it('rechaza un vértice que no es [lng, lat] numérico', async () => {
    await expect(
      service.create({ name: 'Mal', polygon: [[1, 2], [3], [4, 5]] }, 'd1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sin zonas cargadas, todo está cubierto sin recargo', async () => {
    repo.count.mockResolvedValue(0);
    await expect(service.checkCoverage('d1', -27, -55)).resolves.toEqual({
      covered: true,
      surcharge: 0,
    });
    expect(repo.query).not.toHaveBeenCalled();
  });

  it('fuera de toda zona activa, no está cubierto', async () => {
    repo.count.mockResolvedValue(2);
    repo.query.mockResolvedValue([]);
    await expect(service.checkCoverage('d1', -27, -55)).resolves.toEqual({
      covered: false,
      surcharge: 0,
    });
  });

  it('dentro de una zona, devuelve la zona y su recargo como número', async () => {
    repo.count.mockResolvedValue(2);
    repo.query.mockResolvedValue([
      { coverage_zone_id: 'z1', name: 'Centro', surcharge: '500.00' },
    ]);
    await expect(service.checkCoverage('d1', -27, -55)).resolves.toEqual({
      covered: true,
      zoneId: 'z1',
      zoneName: 'Centro',
      surcharge: 500,
    });
  });
});
