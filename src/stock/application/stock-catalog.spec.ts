import { DataSource, EntityManager } from 'typeorm';
import { StockInsuficienteError } from '../domain/errors/stock.errors';
import { GasCylinder } from '../../gascylinder/entities/gascylinder.entity';
import { GasCylinderService } from '../../gascylinder/gascylinder.service';
import { GarrafaCreadaEvent } from '../../gascylinder/events/garrafa-creada.event';
import { StockLedgerPort } from '../domain/ports/stock-ledger.port';
import {
  StockAdjustmentReason as Motivo,
  StockCondition as Cond,
  StockMovementReason as Razon,
  StockReferenceType,
} from '../domain/stock.enums';
import { CatalogStockAdjustmentUseCase } from './catalog-stock-adjustment.use-case';
import { GarrafaCreadaListener } from './garrafa-creada.listener';
import { StockAdjustmentUseCase } from './stock-adjustment.use-case';
import { WarehouseService } from './warehouse.service';

const DIST = 'dddddddd-0000-4000-8000-000000000001';
const G1 = '10000000-0000-4000-8000-000000000001';

describe('CatalogStockAdjustmentUseCase (PATCH /gascylinder/:id/stock)', () => {
  const armar = () => {
    const products = {
      findOne: jest
        .fn()
        .mockResolvedValue({ gasCylinderId: G1 } as GasCylinder),
    };
    const warehouses = {
      asegurarPredeterminado: jest
        .fn()
        .mockResolvedValue({ warehouse: { warehouseId: 'w1' } }),
    };
    const adjustments = { execute: jest.fn().mockResolvedValue('adj-1') };
    const dataSource = {
      query: jest.fn().mockResolvedValue([{ camiones: 0, otros: 0 }]),
    };
    const uc = new CatalogStockAdjustmentUseCase(
      products as unknown as GasCylinderService,
      warehouses as unknown as WarehouseService,
      adjustments as unknown as StockAdjustmentUseCase,
      dataSource as unknown as DataSource,
    );
    return { uc, products, warehouses, adjustments, dataSource };
  };

  it('es una corrección de conteo de llenas en el depósito predeterminado, con nota', async () => {
    const { uc, adjustments } = armar();
    await uc.execute(G1, -3, DIST, 'u1');
    expect(adjustments.execute).toHaveBeenCalledWith(
      {
        location: { warehouseId: 'w1' },
        reason: Motivo.COUNT_CORRECTION,
        notes: expect.stringContaining('catálogo') as string,
        items: [{ gasCylinderId: G1, condition: Cond.FULL, quantityDelta: -3 }],
      },
      DIST,
      'u1',
    );
  });

  it('un producto de otra distribuidora es 404 y no ajusta nada', async () => {
    const { uc, products, adjustments } = armar();
    products.findOne.mockRejectedValue(new Error('404'));
    await expect(uc.execute(G1, 1, DIST, 'u1')).rejects.toThrow('404');
    expect(products.findOne).toHaveBeenCalledWith(G1, DIST);
    expect(adjustments.execute).not.toHaveBeenCalled();
  });

  const faltante = (available: number) =>
    new StockInsuficienteError([
      {
        locationId: 'l1',
        locationLabel: 'Depósito central',
        gasCylinderId: G1,
        gasCylinderType: '10kg',
        condition: Cond.FULL,
        available,
        requested: 9,
      },
    ]);

  it('al restar más de lo que hay en el predeterminado, el mensaje dice que las llenas están en camiones', async () => {
    const { uc, adjustments, dataSource } = armar();
    adjustments.execute.mockRejectedValue(faltante(2));
    dataSource.query.mockResolvedValue([{ camiones: 15, otros: 0 }]);
    await expect(uc.execute(G1, -9, DIST, 'u1')).rejects.toThrow(
      /sólo tiene 2 llenas.*15 en camiones.*transferilas/,
    );
  });

  it('si no hay llenas en ningún lado lo dice', async () => {
    const { uc, adjustments } = armar();
    adjustments.execute.mockRejectedValue(faltante(0));
    await expect(uc.execute(G1, -9, DIST, 'u1')).rejects.toThrow(
      /No hay más llenas en ningún lado/,
    );
  });

  it('otros errores pasan tal cual', async () => {
    const { uc, adjustments } = armar();
    adjustments.execute.mockRejectedValue(new Error('boom'));
    await expect(uc.execute(G1, -1, DIST, 'u1')).rejects.toThrow('boom');
  });

  it('cantidad cero no hace nada (como antes)', async () => {
    const { uc, adjustments } = armar();
    await uc.execute(G1, 0, DIST, 'u1');
    expect(adjustments.execute).not.toHaveBeenCalled();
  });
});

describe('GarrafaCreadaListener', () => {
  const armar = () => {
    const manager = {} as EntityManager;
    const ledger = { aplicar: jest.fn().mockResolvedValue({ batchId: 'b' }) };
    const warehouses = {
      asegurarPredeterminado: jest
        .fn()
        .mockResolvedValue({ locationId: 'loc-1' }),
    };
    const listener = new GarrafaCreadaListener(
      ledger as unknown as StockLedgerPort,
      warehouses as unknown as WarehouseService,
    );
    return { listener, ledger, warehouses, manager };
  };

  it('registra el stock inicial como llenas del predeterminado, SIN tocar el vendible y en el manager del alta', async () => {
    const { listener, ledger, warehouses, manager } = armar();
    await listener.handle(new GarrafaCreadaEvent(G1, DIST, 12, manager));
    expect(warehouses.asegurarPredeterminado).toHaveBeenCalledWith(
      DIST,
      manager,
    );
    expect(ledger.aplicar).toHaveBeenCalledWith(manager, {
      distributorId: DIST,
      referenceType: StockReferenceType.INITIAL,
      referenceId: G1,
      actorUserId: null,
      vendible: 'sin-cambio',
      movimientos: [
        {
          gasCylinderId: G1,
          quantity: 12,
          from: null,
          to: { locationId: 'loc-1', condition: Cond.FULL },
          reason: Razon.INITIAL_COUNT,
        },
      ],
    });
  });

  it('sin stock inicial no hace nada', async () => {
    const { listener, ledger, manager } = armar();
    await listener.handle(new GarrafaCreadaEvent(G1, DIST, 0, manager));
    expect(ledger.aplicar).not.toHaveBeenCalled();
  });

  it('si el libro falla, el error sube (deshace el alta del producto)', async () => {
    const { listener, ledger, manager } = armar();
    ledger.aplicar.mockRejectedValue(new Error('boom'));
    await expect(
      listener.handle(new GarrafaCreadaEvent(G1, DIST, 5, manager)),
    ).rejects.toThrow('boom');
  });
});
