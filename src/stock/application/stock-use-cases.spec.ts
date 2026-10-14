import { ConflictException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { DocumentSequenceService } from '../../document-sequence/document-sequence.service';
import { OperacionDeStockInvalidaError } from '../domain/errors/stock.errors';
import { StockLedgerPort } from '../domain/ports/stock-ledger.port';
import {
  StockAdjustmentReason as Motivo,
  StockCondition as Cond,
  StockLocationKind,
  StockMovementReason as Razon,
  StockReferenceType,
} from '../domain/stock.enums';
import { StockAdjustment } from '../entities/stock-adjustment.entity';
import { StockAdjustmentItem } from '../entities/stock-adjustment-item.entity';
import { InitialCountUseCase } from './initial-count.use-case';
import { ReverseBatchUseCase } from './reverse-batch.use-case';
import { StockAdjustmentUseCase } from './stock-adjustment.use-case';
import { StockLocationService } from './stock-location.service';
import { StockTransferUseCase } from './stock-transfer.use-case';

const DIST = 'dddddddd-0000-4000-8000-000000000001';
const L1 = '00000000-0000-4000-8000-000000000001';
const L2 = '00000000-0000-4000-8000-000000000002';
const G1 = '10000000-0000-4000-8000-000000000001';
const W1 = 'a0000000-0000-4000-8000-000000000001';

function armar(
  over: {
    saldos?: unknown[];
    conteoPrevio?: boolean;
    primerMovimiento?: unknown;
  } = {},
) {
  const orden: string[] = [];
  const guardados: Record<string, unknown[]> = {};
  const repo = (entidad: unknown) => ({
    create: (d: unknown) => d,
    save: jest.fn((d: unknown) => {
      orden.push(`save:${(entidad as { name: string }).name}`);
      (guardados[(entidad as { name: string }).name] ??= []).push(d);
      return Promise.resolve(d);
    }),
    insert: jest.fn((d: unknown) => {
      orden.push(`insert:${(entidad as { name: string }).name}`);
      (guardados[(entidad as { name: string }).name] ??= []).push(d);
      return Promise.resolve();
    }),
    exists: jest.fn().mockResolvedValue(over.conteoPrevio ?? false),
    findOne: jest.fn().mockResolvedValue(over.primerMovimiento ?? null),
    createQueryBuilder: jest.fn(() => ({
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({}),
    })),
  });
  const manager = {
    getRepository: jest.fn((e: unknown) => repo(e)),
    query: jest.fn().mockResolvedValue(over.saldos ?? []),
  } as unknown as EntityManager;
  const transaction = jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
    cb(manager),
  );
  const dataSource = { transaction } as unknown as DataSource;
  const ledger = {
    aplicar: jest.fn(() => {
      orden.push('ledger');
      return Promise.resolve({ batchId: 'batch-1', movementIds: [] });
    }),
    contraasentar: jest
      .fn()
      .mockResolvedValue({ batchId: 'batch-2', movementIds: [] }),
  };
  const sequences = {
    siguienteNumero: jest.fn(() => {
      orden.push('numero');
      return Promise.resolve(7);
    }),
  };
  const locations = {
    resolver: jest.fn(
      (
        _m: unknown,
        _d: string,
        ref: { warehouseId?: string; carId?: string },
      ) =>
        Promise.resolve(
          ref.carId
            ? {
                locationId: L2,
                kind: StockLocationKind.VEHICLE,
                carId: ref.carId,
              }
            : {
                locationId: ref.warehouseId === W1 ? L1 : L2,
                kind: StockLocationKind.WAREHOUSE,
              },
        ),
    ),
    ubicacionDeDeposito: jest.fn().mockResolvedValue({ locationId: L1 }),
  };
  return {
    manager,
    dataSource,
    transaction,
    ledger,
    sequences,
    locations,
    orden,
    guardados,
  };
}

describe('StockAdjustmentUseCase', () => {
  const dto = {
    location: { warehouseId: W1 },
    reason: Motivo.SHRINKAGE,
    notes: 'se rompieron dos',
    items: [{ gasCylinderId: G1, condition: Cond.FULL, quantityDelta: -2 }],
  };
  const crear = (a: ReturnType<typeof armar>) =>
    new StockAdjustmentUseCase(
      a.dataSource,
      a.ledger as unknown as StockLedgerPort,
      a.locations as unknown as StockLocationService,
      a.sequences as unknown as DocumentSequenceService,
    );

  it('mueve el libro, toma el número DESPUÉS (último lock) y guarda cabecera e ítems', async () => {
    const a = armar();
    const id = await crear(a).execute(dto, DIST, 'u1');

    expect(a.orden).toEqual([
      'ledger',
      'numero',
      'save:StockAdjustment',
      'insert:StockAdjustmentItem',
    ]);
    expect(a.ledger.aplicar).toHaveBeenCalledWith(
      a.manager,
      expect.objectContaining({
        distributorId: DIST,
        referenceType: StockReferenceType.STOCK_ADJUSTMENT,
        referenceId: id,
        actorUserId: 'u1',
        movimientos: [
          expect.objectContaining({
            reason: Razon.SHRINKAGE,
            quantity: 2,
            to: null,
          }),
        ],
      }),
    );
    expect(a.guardados[StockAdjustment.name][0]).toMatchObject({
      adjustmentId: id,
      number: 7,
      locationId: L1,
      reason: Motivo.SHRINKAGE,
      notes: 'se rompieron dos',
      batchId: 'batch-1',
      createdByUserId: 'u1',
    });
    expect(a.guardados[StockAdjustmentItem.name][0]).toEqual([
      {
        adjustmentId: id,
        gasCylinderId: G1,
        condition: Cond.FULL,
        quantityDelta: -2,
      },
    ]);
  });

  it('rechaza un signo inválido para el motivo antes de abrir la transacción', async () => {
    const a = armar();
    await expect(
      crear(a).execute(
        {
          ...dto,
          items: [
            { gasCylinderId: G1, condition: Cond.FULL, quantityDelta: 3 },
          ],
        },
        DIST,
        'u1',
      ),
    ).rejects.toBeInstanceOf(OperacionDeStockInvalidaError);
    expect(a.transaction).not.toHaveBeenCalled();
  });

  it('si el libro falla no queda nada guardado (número ni cabecera)', async () => {
    const a = armar();
    a.ledger.aplicar.mockRejectedValueOnce(new Error('sin saldo'));
    await expect(crear(a).execute(dto, DIST, 'u1')).rejects.toThrow(
      'sin saldo',
    );
    expect(a.sequences.siguienteNumero).not.toHaveBeenCalled();
    expect(a.orden).toEqual([]);
  });
});

describe('InitialCountUseCase', () => {
  const dto = {
    warehouseId: W1,
    items: [{ gasCylinderId: G1, full: 40, empty: 10 }],
  };
  const crear = (a: ReturnType<typeof armar>) =>
    new InitialCountUseCase(
      a.dataSource,
      a.ledger as unknown as StockLedgerPort,
      a.locations as unknown as StockLocationService,
      a.sequences as unknown as DocumentSequenceService,
    );

  it('registra las diferencias contra el saldo actual como initial_count', async () => {
    const a = armar({
      saldos: [{ gas_cylinder_id: G1, condition: Cond.FULL, quantity: 30 }],
    });
    await crear(a).execute(dto, DIST, 'u1');

    const op = a.ledger.aplicar.mock.calls[0] as unknown as [
      unknown,
      {
        movimientos: Array<{
          reason: Razon;
          quantity: number;
          from: unknown;
          to: { condition: Cond } | null;
        }>;
      },
    ];
    // llenas 30 → 40 (+10) y vacías 0 → 10 (+10); defectuosas 0 → 0 no se registran.
    expect(
      op[1].movimientos.map((m) => [m.to?.condition, m.quantity, m.reason]),
    ).toEqual([
      [Cond.FULL, 10, Razon.INITIAL_COUNT],
      [Cond.EMPTY, 10, Razon.INITIAL_COUNT],
    ]);
    expect(a.guardados[StockAdjustment.name][0]).toMatchObject({
      reason: Motivo.INITIAL_COUNT,
      notes: 'Conteo inicial del depósito',
      number: 7,
    });
  });

  it('se hace una sola vez por depósito: el segundo es 409', async () => {
    const a = armar({ conteoPrevio: true });
    await expect(crear(a).execute(dto, DIST, 'u1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(a.ledger.aplicar).not.toHaveBeenCalled();
  });

  it('un conteo que coincide con el saldo no registra nada', async () => {
    const a = armar({
      saldos: [
        { gas_cylinder_id: G1, condition: Cond.FULL, quantity: 40 },
        { gas_cylinder_id: G1, condition: Cond.EMPTY, quantity: 10 },
      ],
    });
    await expect(crear(a).execute(dto, DIST, 'u1')).rejects.toThrow(
      /no hay nada que registrar/,
    );
    expect(a.ledger.aplicar).not.toHaveBeenCalled();
  });

  it('rechaza dos renglones de la misma garrafa', async () => {
    const a = armar();
    await expect(
      crear(a).execute(
        { ...dto, items: [dto.items[0], dto.items[0]] },
        DIST,
        'u1',
      ),
    ).rejects.toBeInstanceOf(OperacionDeStockInvalidaError);
  });
});

describe('StockTransferUseCase', () => {
  const crear = (a: ReturnType<typeof armar>) =>
    new StockTransferUseCase(
      a.dataSource,
      a.ledger as unknown as StockLedgerPort,
      a.locations as unknown as StockLocationService,
    );
  const items = [{ gasCylinderId: G1, quantity: 6 }];

  const esperado = (
    batchId: string,
    from: string,
    to: string,
    notes: string,
  ) => ({
    distributorId: DIST,
    referenceType: StockReferenceType.TRANSFER,
    referenceId: batchId,
    batchId,
    actorUserId: 'u1',
    notes,
    movimientos: [
      {
        gasCylinderId: G1,
        quantity: 6,
        from: { locationId: from, condition: Cond.FULL },
        to: { locationId: to, condition: Cond.FULL },
        reason: Razon.TRANSFER,
      },
    ],
  });

  it('transfiere entre depósitos: movimientos transfer con el mismo lote', async () => {
    const a = armar();
    const batchId = await crear(a).execute(
      {
        from: { warehouseId: W1 },
        to: { warehouseId: 'w2' },
        items,
        notes: 'mañana',
      },
      DIST,
      'u1',
    );
    expect(a.ledger.aplicar).toHaveBeenCalledWith(
      a.manager,
      esperado(batchId, L1, L2, 'mañana'),
    );
  });

  it('el camión se carga sólo desde la carga del día: no se transfiere a un vehículo', async () => {
    const a = armar();
    await expect(
      crear(a).execute(
        {
          from: { warehouseId: W1 },
          to: { carId: 'car-1' },
          items,
          notes: 'x',
        },
        DIST,
        'u1',
      ),
    ).rejects.toThrow('El camión se carga y se rinde desde la carga del día');
    expect(a.ledger.aplicar).not.toHaveBeenCalled();
  });

  describe('regularizar el stock suelto de un vehículo (vehículo -> depósito)', () => {
    const devolver = {
      from: { carId: 'car-1' },
      to: { warehouseId: W1 },
      items,
    };

    it('sin carga abierta y con nota, vuelve al depósito', async () => {
      const a = armar();
      const batchId = await crear(a).execute(
        { ...devolver, notes: 'Regularización AB102CH' },
        DIST,
        'u1',
      );
      expect(a.ledger.aplicar).toHaveBeenCalledWith(
        a.manager,
        esperado(batchId, L2, L1, 'Regularización AB102CH'),
      );
    });

    it('con una carga abierta es 409: se rinde desde la carga', async () => {
      const a = armar({ saldos: [{ number: 3 }] });
      await expect(
        crear(a).execute({ ...devolver, notes: 'x' }, DIST, 'u1'),
      ).rejects.toThrow(/carga N° 3/);
      expect(a.ledger.aplicar).not.toHaveBeenCalled();
    });

    it('sin nota es 400', async () => {
      const a = armar();
      await expect(
        crear(a).execute({ ...devolver, notes: '  ' }, DIST, 'u1'),
      ).rejects.toThrow(/indicá en las notas/);
      expect(a.ledger.aplicar).not.toHaveBeenCalled();
    });
  });

  it('el mismo origen y destino es inválido', async () => {
    const a = armar();
    await expect(
      crear(a).execute(
        { from: { warehouseId: W1 }, to: { warehouseId: W1 }, items },
        DIST,
        'u1',
      ),
    ).rejects.toThrow(/la misma ubicación/);
    expect(a.ledger.aplicar).not.toHaveBeenCalled();
  });

  it('no se transfiere de un camión a otro', async () => {
    const a = armar();
    a.locations.resolver
      .mockResolvedValueOnce({
        locationId: L1,
        kind: StockLocationKind.VEHICLE,
      })
      .mockResolvedValueOnce({
        locationId: L2,
        kind: StockLocationKind.VEHICLE,
      });
    await expect(
      crear(a).execute(
        { from: { carId: 'c1' }, to: { carId: 'c2' }, items },
        DIST,
        'u1',
      ),
    ).rejects.toThrow(/de un vehículo a otro/);
  });

  it('dos renglones de la misma garrafa y condición son inválidos', async () => {
    const a = armar();
    await expect(
      crear(a).execute(
        {
          from: { warehouseId: W1 },
          to: { carId: 'c1' },
          items: [...items, ...items],
        },
        DIST,
        'u1',
      ),
    ).rejects.toBeInstanceOf(OperacionDeStockInvalidaError);
  });
});

describe('ReverseBatchUseCase', () => {
  const crear = (a: ReturnType<typeof armar>) =>
    new ReverseBatchUseCase(
      a.dataSource,
      a.ledger as unknown as StockLedgerPort,
    );

  it('contraasienta una transferencia', async () => {
    const a = armar({
      primerMovimiento: { referenceType: StockReferenceType.TRANSFER },
    });
    await expect(
      crear(a).execute('lote-1', 'error de carga', DIST, 'u1'),
    ).resolves.toBe('batch-2');
    expect(a.ledger.contraasentar).toHaveBeenCalledWith(a.manager, {
      distributorId: DIST,
      batchId: 'lote-1',
      actorUserId: 'u1',
      notes: 'error de carga',
    });
  });

  describe('contraasiento de una regularización (vehículo -> depósito)', () => {
    const conQueries = (
      a: ReturnType<typeof armar>,
      respuestas: { haciaCamion?: string | null; cargaAbierta?: number },
    ) =>
      (a.manager.query as jest.Mock).mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes('"truck_load"')
            ? respuestas.cargaAbierta === undefined
              ? []
              : [{ number: respuestas.cargaAbierta }]
            : respuestas.haciaCamion === undefined ||
                respuestas.haciaCamion === null
              ? []
              : [{ patente: respuestas.haciaCamion }],
        ),
      );

    it('mete stock en un camión: 409 y no contraasienta (el camión se carga sólo por la carga del día)', async () => {
      const a = armar({
        primerMovimiento: { referenceType: StockReferenceType.TRANSFER },
      });
      conQueries(a, { haciaCamion: 'AB123CD' });
      await expect(
        crear(a).execute('lote-1', undefined, DIST, 'u1'),
      ).rejects.toThrow(
        /se carga y se rinde desde la carga del día.*camión AB123CD/,
      );
      expect(a.ledger.contraasentar).not.toHaveBeenCalled();
    });

    it('saca stock de un camión con la carga abierta: 409', async () => {
      const a = armar({
        primerMovimiento: { referenceType: StockReferenceType.TRANSFER },
      });
      conQueries(a, { cargaAbierta: 9 });
      await expect(
        crear(a).execute('lote-1', undefined, DIST, 'u1'),
      ).rejects.toThrow(/carga N° 9/);
      expect(a.ledger.contraasentar).not.toHaveBeenCalled();
    });

    it('una transferencia entre depósitos se contraasienta sin cambios', async () => {
      const a = armar({
        primerMovimiento: { referenceType: StockReferenceType.TRANSFER },
      });
      conQueries(a, {});
      await expect(
        crear(a).execute('lote-1', undefined, DIST, 'u1'),
      ).resolves.toBe('batch-2');
    });
  });

  it('un ajuste no se contraasienta: se corrige con otro ajuste', async () => {
    const a = armar({
      primerMovimiento: { referenceType: StockReferenceType.STOCK_ADJUSTMENT },
    });
    await expect(
      crear(a).execute('lote-1', undefined, DIST, 'u1'),
    ).rejects.toThrow(/se corrige con otro ajuste/);
    expect(a.ledger.contraasentar).not.toHaveBeenCalled();
  });

  it('un lote de otra distribuidora es 404', async () => {
    const a = armar({ primerMovimiento: null });
    await expect(
      crear(a).execute('lote-1', undefined, DIST, 'u1'),
    ).rejects.toThrow(/no encontrado/);
  });
});
