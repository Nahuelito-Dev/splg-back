import { ConflictException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { StockInsuficienteError } from '../../stock/domain/errors/stock.errors';
import {
  StockCondition,
  StockMovementReason,
  StockReferenceType,
} from '../../stock/domain/stock.enums';
import { OrdenNoEncontradaError } from '../domain/errors/purchase.errors';
import {
  PurchaseOrderStatus as E,
  SupplierDocumentType,
} from '../domain/purchase.enums';
import { CreatePurchaseReceiptDto } from '../dto/purchase-receipt.dto';
import { PurchaseReceiptItem } from '../entities/purchase-receipt-item.entity';
import { ReceivePurchaseUseCase } from './receive-purchase.use-case';

const DIST = 'dddddddd-0000-4000-8000-000000000001';
const USER = 'uuuuuuuu-0000-4000-8000-000000000001';
const SUP = 'ssssssss-0000-4000-8000-000000000001';
const WH = 'a0000000-0000-4000-8000-000000000001';
const LOC = 'b0000000-0000-4000-8000-000000000001';
const OC = 'c0000000-0000-4000-8000-000000000001';
const G1 = '10000000-0000-4000-8000-000000000001';
const G2 = '10000000-0000-4000-8000-000000000002';

function armar(
  over: {
    orden?: { status: E; supplierId?: string; number?: number } | null;
    items?: Array<{
      gasCylinderId: string;
      quantity: number;
      receivedQuantity: number;
      unitCost: number;
    }>;
    llenasHoy?: number;
    costoPrevio?: number | null;
    ledgerError?: Error;
    documentoRepetido?: boolean;
    /** Cuándo empezó el stock del depósito (su conteo inicial o su alta). */
    inicioDelDeposito?: Date | null;
  } = {},
) {
  const eventos: string[] = [];
  const guardados: unknown[] = [];
  const orden =
    over.orden === null
      ? null
      : over.orden
        ? {
            purchaseOrderId: OC,
            number: over.orden.number ?? 7,
            supplierId: over.orden.supplierId ?? SUP,
            destinationWarehouseId: WH,
            status: over.orden.status,
          }
        : undefined;
  const items = (over.items ?? []).map((i) => ({ ...i }));
  const manager = {
    query: jest.fn((sql: string) => {
      if (sql.includes('FROM "purchase_receipt"')) {
        return Promise.resolve(over.documentoRepetido ? [{}] : []);
      }
      return Promise.resolve([{ type: '10kg' }]);
    }),
    find: jest.fn(() => Promise.resolve(items)),
    save: jest.fn((x: unknown) => {
      eventos.push('save');
      guardados.push(x);
      return Promise.resolve(x);
    }),
    create: jest.fn((_e: unknown, d: unknown) => d),
    insert: jest.fn((e: unknown, d: unknown) => {
      eventos.push(`insert:${(e as { name: string }).name}`);
      guardados.push(d);
      return Promise.resolve();
    }),
  } as unknown as EntityManager;
  const dataSource = {
    transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
      cb(manager),
    ),
  } as unknown as DataSource;
  const ledger = {
    aplicar: jest.fn(() => {
      eventos.push('ledger');
      if (over.ledgerError) return Promise.reject(over.ledgerError);
      return Promise.resolve({ batchId: 'batch-1', movementIds: [] });
    }),
    contraasentar: jest.fn(),
  };
  const orders = {
    bloquear: jest.fn(() => {
      eventos.push('lock-orden');
      return orden
        ? Promise.resolve(orden)
        : Promise.reject(new OrdenNoEncontradaError(OC));
    }),
  };
  const suppliers = { bloquearUsable: jest.fn().mockResolvedValue(undefined) };
  const locations = {
    ubicacionDeDeposito: jest.fn().mockResolvedValue({ locationId: LOC }),
  };
  const warehouses = {
    asegurarPredeterminado: jest
      .fn()
      .mockResolvedValue({ warehouse: { warehouseId: WH } }),
  };
  const products = {
    costoPromedio: jest.fn().mockResolvedValue(over.costoPrevio ?? null),
    fijarCostoPromedio: jest.fn().mockResolvedValue(undefined),
  };
  const onHand = {
    llenasTotales: jest.fn().mockResolvedValue(over.llenasHoy ?? 0),
    inicioDeStockDelDeposito: jest
      .fn()
      .mockResolvedValue(
        over.inicioDelDeposito === undefined
          ? new Date('2026-10-11T20:00:00Z')
          : over.inicioDelDeposito,
      ),
  };
  const sequences = {
    siguienteNumero: jest.fn(() => {
      eventos.push('numero');
      return Promise.resolve(3);
    }),
  };
  const useCase = new ReceivePurchaseUseCase(
    dataSource,
    ledger as never,
    orders as never,
    suppliers as never,
    locations as never,
    warehouses as never,
    products as never,
    onHand as never,
    sequences as never,
  );
  return {
    useCase,
    ledger,
    orders,
    products,
    suppliers,
    eventos,
    guardados,
    items,
    orden,
    manager,
    onHand,
  };
}

const dto = (
  over: Partial<CreatePurchaseReceiptDto> = {},
): CreatePurchaseReceiptDto => ({
  supplierDocumentType: SupplierDocumentType.DELIVERY_NOTE,
  supplierDocumentNumber: '0001-1',
  items: [
    {
      gasCylinderId: G1,
      quantityFull: 10,
      quantityEmptyOut: 4,
      unitCost: 1000,
    },
  ],
  ...over,
});

describe('ReceivePurchaseUseCase', () => {
  it('sin orden: pide proveedor y costo', async () => {
    const { useCase } = armar({ orden: null });
    await expect(useCase.execute(dto(), DIST, USER)).rejects.toThrow(
      /necesita el proveedor/,
    );
    await expect(
      useCase.execute(
        dto({
          supplierId: SUP,
          items: [{ gasCylinderId: G1, quantityFull: 1 }],
        }),
        DIST,
        USER,
      ),
    ).rejects.toThrow(/necesita el costo unitario/);
  });

  it('mueve el ledger: +llenas, −vacías, con el orden de locks y el número al final', async () => {
    const { useCase, ledger, eventos } = armar({ orden: null });
    await useCase.execute(dto({ supplierId: SUP }), DIST, USER);
    const [, op] = ledger.aplicar.mock.calls[0] as unknown as [
      unknown,
      { referenceType: string; movimientos: unknown[] },
    ];
    expect(op.referenceType).toBe(StockReferenceType.PURCHASE_RECEIPT);
    expect(op.movimientos).toEqual([
      expect.objectContaining({
        gasCylinderId: G1,
        quantity: 10,
        from: null,
        to: { locationId: LOC, condition: StockCondition.FULL },
        reason: StockMovementReason.PURCHASE_RECEIPT,
      }),
      expect.objectContaining({
        gasCylinderId: G1,
        quantity: 4,
        from: { locationId: LOC, condition: StockCondition.EMPTY },
        to: null,
        reason: StockMovementReason.PLANT_EMPTY_OUT,
      }),
    ]);
    expect(eventos.indexOf('ledger')).toBeLessThan(eventos.indexOf('numero'));
    expect(eventos.indexOf('numero')).toBeLessThan(
      eventos.indexOf('insert:PurchaseReceiptItem'),
    );
  });

  it('si no alcanzan las vacías responde 400 claro y no escribe nada más', async () => {
    const error = new StockInsuficienteError([
      {
        locationId: LOC,
        locationLabel: 'Depósito central',
        gasCylinderId: G1,
        gasCylinderType: '10kg',
        condition: StockCondition.EMPTY,
        available: 1,
        requested: 4,
      },
    ]);
    const { useCase, products, eventos } = armar({
      orden: null,
      ledgerError: error,
    });
    await expect(
      useCase.execute(dto({ supplierId: SUP }), DIST, USER),
    ).rejects.toThrow(
      /No alcanzan las vacías.*10kg vacías en Depósito central \(hay 1, se necesitan 4\)/,
    );
    expect(products.fijarCostoPromedio).not.toHaveBeenCalled();
    expect(eventos).not.toContain('numero');
  });

  it('calcula el costo promedio ponderado con la existencia previa', async () => {
    // hoy hay 40 llenas (30 previas + 10 que acaban de entrar) a 1000; entran 10 a 1400
    const { useCase, products } = armar({
      orden: null,
      llenasHoy: 40,
      costoPrevio: 1000,
    });
    await useCase.execute(
      dto({
        supplierId: SUP,
        items: [{ gasCylinderId: G1, quantityFull: 10, unitCost: 1400 }],
      }),
      DIST,
      USER,
    );
    expect(products.fijarCostoPromedio).toHaveBeenCalledWith(
      expect.anything(),
      DIST,
      G1,
      1100,
    );
  });

  it('con orden: toma su lock primero, usa su costo y actualiza lo recibido y el estado', async () => {
    const { useCase, eventos, items, orden, ledger } = armar({
      orden: { status: E.SENT },
      items: [
        { gasCylinderId: G1, quantity: 10, receivedQuantity: 0, unitCost: 900 },
        { gasCylinderId: G2, quantity: 5, receivedQuantity: 0, unitCost: 500 },
      ],
    });
    await useCase.execute(
      dto({
        purchaseOrderId: OC,
        items: [{ gasCylinderId: G1, quantityFull: 4 }],
      }),
      DIST,
      USER,
    );
    expect(eventos[0]).toBe('lock-orden');
    expect(eventos.indexOf('lock-orden')).toBeLessThan(
      eventos.indexOf('ledger'),
    );
    expect(items[0].receivedQuantity).toBe(4);
    expect(orden?.status).toBe(E.PARTIALLY_RECEIVED);
    const guardado = (useCase as unknown as { dataSource: DataSource })
      .dataSource;
    expect(guardado).toBeDefined();
    expect(ledger.aplicar).toHaveBeenCalledTimes(1);
  });

  it('recibir lo que falta cierra la orden', async () => {
    const { useCase, orden } = armar({
      orden: { status: E.PARTIALLY_RECEIVED },
      items: [
        { gasCylinderId: G1, quantity: 10, receivedQuantity: 6, unitCost: 900 },
      ],
    });
    await useCase.execute(
      dto({
        purchaseOrderId: OC,
        items: [{ gasCylinderId: G1, quantityFull: 4 }],
      }),
      DIST,
      USER,
    );
    expect(orden?.status).toBe(E.RECEIVED);
  });

  it('no deja pasarse de lo pendiente', async () => {
    const { useCase, ledger } = armar({
      orden: { status: E.PARTIALLY_RECEIVED },
      items: [
        { gasCylinderId: G1, quantity: 10, receivedQuantity: 6, unitCost: 900 },
      ],
    });
    await expect(
      useCase.execute(
        dto({
          purchaseOrderId: OC,
          items: [{ gasCylinderId: G1, quantityFull: 5 }],
        }),
        DIST,
        USER,
      ),
    ).rejects.toThrow(/se pasa de lo pedido.*llegan 5 y sólo quedan 4/);
    expect(ledger.aplicar).not.toHaveBeenCalled();
  });

  it.each([E.DRAFT, E.RECEIVED, E.CANCELLED])(
    'una orden %s no se recibe',
    async (status) => {
      const { useCase } = armar({
        orden: { status },
        items: [
          {
            gasCylinderId: G1,
            quantity: 10,
            receivedQuantity: 0,
            unitCost: 900,
          },
        ],
      });
      await expect(
        useCase.execute(
          dto({
            purchaseOrderId: OC,
            items: [{ gasCylinderId: G1, quantityFull: 1 }],
          }),
          DIST,
          USER,
        ),
      ).rejects.toThrow(
        /sólo se recibe una orden enviada o parcialmente recibida/,
      );
    },
  );

  it('una garrafa que no está en la orden se rechaza', async () => {
    const { useCase } = armar({
      orden: { status: E.SENT },
      items: [
        { gasCylinderId: G1, quantity: 10, receivedQuantity: 0, unitCost: 900 },
      ],
    });
    await expect(
      useCase.execute(
        dto({
          purchaseOrderId: OC,
          items: [{ gasCylinderId: G2, quantityFull: 1 }],
        }),
        DIST,
        USER,
      ),
    ).rejects.toThrow(/no está en la orden de compra/);
  });

  it('la orden de otra distribuidora es 404 (el lock filtra por tenant)', async () => {
    const { useCase, orders } = armar({ orden: undefined });
    await expect(
      useCase.execute(
        dto({
          purchaseOrderId: OC,
          items: [{ gasCylinderId: G1, quantityFull: 1 }],
        }),
        DIST,
        USER,
      ),
    ).rejects.toBeInstanceOf(OrdenNoEncontradaError);
    expect(orders.bloquear).toHaveBeenCalledWith(expect.anything(), OC, DIST);
  });

  it('el proveedor indicado tiene que ser el de la orden', async () => {
    const { useCase } = armar({
      orden: { status: E.SENT },
      items: [
        { gasCylinderId: G1, quantity: 10, receivedQuantity: 0, unitCost: 900 },
      ],
    });
    await expect(
      useCase.execute(
        dto({
          purchaseOrderId: OC,
          supplierId: 'otro',
          items: [{ gasCylinderId: G1, quantityFull: 1 }],
        }),
        DIST,
        USER,
      ),
    ).rejects.toThrow(/no es el de la orden/);
  });

  it('el mismo documento del proveedor es 409', async () => {
    const { useCase, ledger } = armar({ orden: null, documentoRepetido: true });
    await expect(
      useCase.execute(dto({ supplierId: SUP }), DIST, USER),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(ledger.aplicar).not.toHaveBeenCalled();
  });

  it('no acepta fecha futura', async () => {
    const { useCase } = armar({ orden: null });
    await expect(
      useCase.execute(
        dto({
          supplierId: SUP,
          receivedAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        DIST,
        USER,
      ),
    ).rejects.toThrow(/no puede ser futura/);
  });

  describe('fecha de recepción contra el conteo inicial del depósito', () => {
    it('una recepción fechada antes del conteo inicial es 400 con mensaje claro y no escribe nada', async () => {
      const { useCase, ledger, onHand } = armar({ orden: null });
      await expect(
        useCase.execute(
          dto({ supplierId: SUP, receivedAt: '2026-07-01T10:00:00.000Z' }),
          DIST,
          USER,
        ),
      ).rejects.toThrow(/es anterior al conteo inicial de este depósito/);
      expect(onHand.inicioDeStockDelDeposito).toHaveBeenCalledWith(
        expect.anything(),
        DIST,
        WH,
      );
      expect(ledger.aplicar).not.toHaveBeenCalled();
    });

    it('una fecha posterior al inicio del depósito se respeta en el libro', async () => {
      const { useCase, ledger } = armar({ orden: null });
      await useCase.execute(
        dto({ supplierId: SUP, receivedAt: '2026-10-12T09:00:00.000Z' }),
        DIST,
        USER,
      );
      const [, op] = ledger.aplicar.mock.calls[0] as unknown as [
        unknown,
        { occurredAt: Date },
      ];
      expect(op.occurredAt).toEqual(new Date('2026-10-12T09:00:00.000Z'));
    });

    it('sin conteo inicial no hay piso: una fecha pasada se acepta', async () => {
      const { useCase, ledger } = armar({
        orden: null,
        inicioDelDeposito: null,
      });
      await useCase.execute(
        dto({ supplierId: SUP, receivedAt: '2020-01-01T10:00:00.000Z' }),
        DIST,
        USER,
      );
      expect(ledger.aplicar).toHaveBeenCalled();
    });

    it('sin fecha (ahora) no consulta el inicio del depósito', async () => {
      const { useCase, onHand } = armar({ orden: null });
      await useCase.execute(dto({ supplierId: SUP }), DIST, USER);
      expect(onHand.inicioDeStockDelDeposito).not.toHaveBeenCalled();
    });
  });

  it('guarda el renglón del remito con el costo del pedido', async () => {
    const { useCase, guardados } = armar({
      orden: { status: E.SENT },
      items: [
        { gasCylinderId: G1, quantity: 10, receivedQuantity: 0, unitCost: 900 },
      ],
    });
    await useCase.execute(
      dto({
        purchaseOrderId: OC,
        items: [{ gasCylinderId: G1, quantityFull: 2, quantityEmptyOut: 2 }],
      }),
      DIST,
      USER,
    );
    const insertados = guardados.find(
      (g) =>
        Array.isArray(g) &&
        (g[0] as Partial<PurchaseReceiptItem>)?.quantityEmptyOut === 2,
    ) as PurchaseReceiptItem[];
    expect(insertados[0]).toEqual(
      expect.objectContaining({
        gasCylinderId: G1,
        unitCost: 900,
        quantityFull: 2,
      }),
    );
  });

  it('guarda en cada renglón el promedio y la existencia previos', async () => {
    const { useCase, guardados } = armar({
      orden: null,
      llenasHoy: 40,
      costoPrevio: 1000,
    });
    await useCase.execute(
      dto({
        supplierId: SUP,
        items: [{ gasCylinderId: G1, quantityFull: 10, unitCost: 1400 }],
      }),
      DIST,
      USER,
    );
    const renglones = guardados.find(
      (g) =>
        Array.isArray(g) &&
        (g[0] as Partial<PurchaseReceiptItem>)?.previousOnHand !== undefined,
    ) as PurchaseReceiptItem[];
    expect(renglones[0]).toEqual(
      expect.objectContaining({
        previousAverageCost: 1000,
        previousOnHand: 30,
      }),
    );
  });
});
