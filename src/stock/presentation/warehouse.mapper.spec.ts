import type { Point } from 'typeorm';
import { Warehouse } from '../entities/warehouse.entity';
import { WarehouseKind } from '../domain/stock.enums';
import { WarehouseMapper } from './warehouse.mapper';

const deposito = (location: Point | null): Warehouse =>
  ({
    warehouseId: 'w1',
    distributorId: 'd1',
    name: 'Galpón',
    code: 'GAL',
    kind: WarehouseKind.DEPOT,
    address: 'Av. Uruguay 1234, Posadas',
    location,
    isDefault: true,
    isActive: true,
    createdAt: new Date('2026-11-13T00:00:00Z'),
    updatedAt: new Date('2026-11-13T00:00:00Z'),
    deletedAt: null,
  }) as Warehouse;

describe('WarehouseMapper', () => {
  it('v2 devuelve la latitud y la longitud del punto (GeoJSON va lng, lat)', () => {
    const dto = WarehouseMapper.toV2Dto({
      warehouse: deposito({ type: 'Point', coordinates: [-55.8961, -27.3671] }),
      locationId: 'loc-1',
    });
    expect(dto).toMatchObject({
      warehouseId: 'w1',
      locationId: 'loc-1',
      latitude: -27.3671,
      longitude: -55.8961,
    });
  });

  it('v2 sin ubicación devuelve null en las dos', () => {
    const dto = WarehouseMapper.toV2DetailDto(
      { warehouse: deposito(null), locationId: 'loc-1' },
      [],
    );
    expect(dto).toMatchObject({
      latitude: null,
      longitude: null,
      balances: [],
    });
  });

  it('v1 no expone la ubicación: su contrato no cambia', () => {
    const dto = WarehouseMapper.toDto({
      warehouse: deposito({ type: 'Point', coordinates: [-55.8961, -27.3671] }),
      locationId: 'loc-1',
    });
    expect(dto).not.toHaveProperty('latitude');
    expect(dto).not.toHaveProperty('longitude');
    expect(dto).not.toHaveProperty('location');
  });
});
