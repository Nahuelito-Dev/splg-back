import { NotFoundException } from '@nestjs/common';
import type { EntityManager, Repository } from 'typeorm';
import type { CarService } from '../../car/car.service';
import { OperacionDeStockInvalidaError } from '../domain/errors/stock.errors';
import { StockLocation } from '../entities/stock-location.entity';
import { StockLocationService } from './stock-location.service';

const DIST = 'dddddddd-0000-4000-8000-000000000001';
const WH = 'a0000000-0000-4000-8000-000000000001';

function armar(fila: { is_active: boolean } | null) {
  const orden: string[] = [];
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['innerJoin', 'where', 'andWhere']) qb[m] = jest.fn(() => qb);
  qb.getOne = jest.fn().mockResolvedValue({ locationId: 'loc-1' });
  const manager = {
    query: jest.fn((sql: string) => {
      orden.push(sql.includes('FOR SHARE') ? 'lock-deposito' : 'otra');
      return Promise.resolve(fila ? [fila] : []);
    }),
    getRepository: jest.fn((e: unknown) => {
      expect(e).toBe(StockLocation);
      orden.push('ubicacion');
      return { createQueryBuilder: jest.fn(() => qb) };
    }),
  } as unknown as EntityManager;
  const service = new StockLocationService(
    {} as Repository<StockLocation>,
    {} as CarService,
  );
  return { service, manager, orden };
}

describe('StockLocationService.ubicacionDeOrigenDeCarga', () => {
  it('un depósito activo se toma FOR SHARE (frena su baja) y devuelve su ubicación', async () => {
    const { service, manager, orden } = armar({ is_active: true });
    await expect(
      service.ubicacionDeOrigenDeCarga(manager, DIST, WH),
    ).resolves.toEqual({ locationId: 'loc-1' });
    expect(orden).toEqual(['lock-deposito', 'ubicacion']);
  });

  it('un depósito inactivo no puede ser origen de una carga: 400 claro', async () => {
    const { service, manager } = armar({ is_active: false });
    await expect(
      service.ubicacionDeOrigenDeCarga(manager, DIST, WH),
    ).rejects.toThrow(OperacionDeStockInvalidaError);
    await expect(
      service.ubicacionDeOrigenDeCarga(manager, DIST, WH),
    ).rejects.toThrow(/origen está inactivo/);
  });

  it('un depósito dado de baja o de otra distribuidora es 404', async () => {
    const { service, manager } = armar(null);
    await expect(
      service.ubicacionDeOrigenDeCarga(manager, DIST, WH),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
