import { ConflictException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import type { DocumentSequenceService } from '../../document-sequence/document-sequence.service';
import type { GasCylinderService } from '../../gascylinder/gascylinder.service';
import type { OrderLookupService } from '../../order/lookup/order-lookup.service';
import {
  GarrafaNoEncontradaEnStockError,
  OperacionDeStockInvalidaError,
} from '../domain/errors/stock.errors';
import { StockAdjustment } from '../entities/stock-adjustment.entity';
import { StockAdjustmentItem } from '../entities/stock-adjustment-item.entity';
import { ReconciliationAdjustmentUseCase } from './reconciliation-adjustment.use-case';
import type { StockReconciliationService } from './stock-reconciliation.service';
import type { WarehouseService } from './warehouse.service';

const DIST = 'dddddddd-0000-4000-8000-000000000001';
const G1 = '10000000-0000-4000-8000-000000000001';

interface Escenario {
  existe?: boolean;
  /** vendible guardado */
  stock?: number;
  deficit?: number;
  fisico?: number;
  reservadas?: number;
  sinDescontar?: number;
}

function armar(e: Escenario = {}) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const guardados: Record<string, unknown[]> = {};
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.includes('FOR UPDATE'))
      return Promise.resolve([
        { stock: e.stock ?? 0, reservation_deficit: e.deficit ?? 0 },
      ]);
    if (sql.includes('SUM("quantity")'))
      return Promise.resolve([{ total: String(e.fisico ?? 0) }]);
    if (sql.includes('UPDATE "gas_cylinder"')) return Promise.resolve([]);
    return Promise.resolve(
      e.existe === false ? [] : [{ stock: 0, type: '25kg' }],
    );
  });
  const repo = (entidad: { name: string }) => ({
    create: (d: unknown) => d,
    save: jest.fn((d: unknown) => {
      (guardados[entidad.name] ??= []).push(d);
      return Promise.resolve(d);
    }),
    insert: jest.fn((d: unknown) => {
      (guardados[entidad.name] ??= []).push(d);
      return Promise.resolve();
    }),
  });
  const manager = {
    query,
    getRepository: jest.fn((entidad: { name: string }) => repo(entidad)),
  } as unknown as EntityManager;
  const dataSource = {
    transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
      cb(manager),
    ),
  } as unknown as DataSource;
  const products = { ajustarVendible: jest.fn().mockResolvedValue([]) };
  const useCase = new ReconciliationAdjustmentUseCase(
    dataSource,
    products as unknown as GasCylinderService,
    {
      reservedByCylinder: jest
        .fn()
        .mockResolvedValue(new Map([[G1, e.reservadas ?? 0]])),
    } as unknown as OrderLookupService,
    {
      siguienteNumero: jest.fn().mockResolvedValue(9),
    } as unknown as DocumentSequenceService,
    {
      asegurarPredeterminado: jest
        .fn()
        .mockResolvedValue({ locationId: 'loc' }),
    } as unknown as WarehouseService,
    {
      unidadesSinMovimientoDe: jest.fn().mockResolvedValue(e.sinDescontar ?? 0),
    } as unknown as StockReconciliationService,
  );
  return { useCase, products, queries, guardados };
}

const ejecutar = (u: ReconciliationAdjustmentUseCase) =>
  u.execute({ gasCylinderId: G1, notes: 'nota' }, DIST, 'u1');

describe('ReconciliationAdjustmentUseCase', () => {
  it('una garrafa inexistente (o de otra distribuidora) es 404, como las demás referencias', async () => {
    const { useCase } = armar({ existe: false });
    await expect(ejecutar(useCase)).rejects.toBeInstanceOf(
      GarrafaNoEncontradaEnStockError,
    );
  });

  it('sin diferencia de vendible ni de déficit se rechaza', async () => {
    const { useCase } = armar({ stock: 6, fisico: 10, reservadas: 4 });
    await expect(ejecutar(useCase)).rejects.toBeInstanceOf(
      OperacionDeStockInvalidaError,
    );
  });

  it('con entregas que todavía no descontaron el físico se rechaza (409) y no corrige nada', async () => {
    const { useCase, products, guardados } = armar({
      stock: 4,
      fisico: 0,
      reservadas: 7,
      sinDescontar: 3,
    });
    await expect(ejecutar(useCase)).rejects.toThrow(
      /primero reaplicá las entregas/,
    );
    await expect(ejecutar(useCase)).rejects.toBeInstanceOf(ConflictException);
    expect(products.ajustarVendible).not.toHaveBeenCalled();
    expect(guardados[StockAdjustment.name]).toBeUndefined();
  });

  it('con entregas sin descontar da 409 aunque el vendible parezca cuadrar (no "sin diferencia")', async () => {
    const { useCase, products } = armar({
      stock: 6,
      fisico: 10,
      reservadas: 4,
      sinDescontar: 2,
    });
    await expect(ejecutar(useCase)).rejects.toBeInstanceOf(ConflictException);
    await expect(ejecutar(useCase)).rejects.toThrow(
      /primero reaplicá las entregas/,
    );
    expect(products.ajustarVendible).not.toHaveBeenCalled();
  });

  it('un déficit desfasado con diferencia 0 se corrige: reescribe el déficit y deja el documento sin renglón', async () => {
    // vendible 0 = esperado 0, pero el déficit guardado (1) no es el real (3 = 7 − 4)
    const { useCase, products, queries, guardados } = armar({
      stock: 0,
      deficit: 1,
      fisico: 4,
      reservadas: 7,
    });
    await ejecutar(useCase);
    expect(products.ajustarVendible).not.toHaveBeenCalled();
    const update = queries.find((q) => q.sql.includes('UPDATE "gas_cylinder"'));
    expect(update?.params).toEqual([G1, 3]);
    expect(guardados[StockAdjustment.name]).toHaveLength(1);
    expect(guardados[StockAdjustmentItem.name]).toBeUndefined();
  });

  it('con diferencia de vendible lo corrige y guarda el renglón y el déficit real', async () => {
    const { useCase, products, queries, guardados } = armar({
      stock: 4,
      fisico: 0,
      reservadas: 7,
    });
    await ejecutar(useCase);
    expect(products.ajustarVendible).toHaveBeenCalledWith(
      expect.anything(),
      DIST,
      [{ gasCylinderId: G1, delta: -4 }],
    );
    expect(
      queries.find((q) => q.sql.includes('UPDATE "gas_cylinder"'))?.params,
    ).toEqual([G1, 7]);
    expect(guardados[StockAdjustmentItem.name]).toEqual([
      expect.objectContaining({ quantityDelta: -4 }),
    ]);
  });
});
