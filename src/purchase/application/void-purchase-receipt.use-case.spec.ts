import { ConflictException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  PurchaseOrderStatus as E,
  PaymentStatus,
  PurchaseReceiptStatus,
} from '../domain/purchase.enums';
import { VoidPurchaseReceiptUseCase } from './void-purchase-receipt.use-case';

const DIST = 'dddddddd-0000-4000-8000-000000000001';
const USER = 'uuuuuuuu-0000-4000-8000-000000000001';
const REC = 'r0000000-0000-4000-8000-000000000001';
const OC = 'c0000000-0000-4000-8000-000000000001';
const G1 = '10000000-0000-4000-8000-000000000001';

function armar(
  over: {
    status?: PurchaseReceiptStatus;
    paymentStatus?: PaymentStatus;
    conOrden?: boolean;
    ordenStatus?: E;
    contraasientoError?: Error;
    llenasHoy?: number;
    costoActual?: number | null;
    lugares?: Array<{ locationName: string; quantity: number }>;
    otras?: { cantidad: number; promedio: string | null; posterior: boolean };
    previo?: { costo: number | null; existencia: number | null };
  } = {},
) {
  const eventos: string[] = [];
  const recepcion = {
    receiptId: REC,
    number: 4,
    distributorId: DIST,
    purchaseOrderId: over.conOrden === false ? null : OC,
    status: over.status ?? PurchaseReceiptStatus.CONFIRMED,
    paymentStatus: over.paymentStatus ?? PaymentStatus.UNPAID,
    batchId: 'batch-1',
    voidBatchId: null as string | null,
    voidReason: null as string | null,
  };
  const orden = { purchaseOrderId: OC, status: over.ordenStatus ?? E.RECEIVED };
  const renglonesOrden = [
    { gasCylinderId: G1, quantity: 10, receivedQuantity: 10 },
  ];
  const itemsRecepcion = [
    {
      gasCylinderId: G1,
      quantityFull: 10,
      quantityEmptyOut: 4,
      unitCost: 1400,
      previousAverageCost: (over.previo ?? { costo: 1000 }).costo,
      previousOnHand: over.previo === undefined ? 30 : over.previo.existencia,
    },
  ];
  const qb = {
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getOne: jest.fn(() => {
      eventos.push('lock-recepcion');
      return Promise.resolve(recepcion);
    }),
  };
  const manager = {
    findOne: jest.fn().mockResolvedValue(recepcion),
    find: jest.fn((entity: { name: string }) =>
      Promise.resolve(
        entity.name === 'PurchaseOrderItem' ? renglonesOrden : itemsRecepcion,
      ),
    ),
    getRepository: jest.fn(() => ({ createQueryBuilder: () => qb })),
    save: jest.fn((x: unknown) => Promise.resolve(x)),
    query: jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('BOOL_OR')
          ? [
              over.otras ?? {
                cantidad: 1,
                promedio: '1000',
                posterior: false,
              },
            ]
          : [{ type: '10kg' }],
      ),
    ),
  } as unknown as EntityManager;
  const dataSource = {
    transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
      cb(manager),
    ),
  } as unknown as DataSource;
  const ledger = {
    contraasentar: jest.fn(() => {
      eventos.push('contraasiento');
      return over.contraasientoError
        ? Promise.reject(over.contraasientoError)
        : Promise.resolve({ batchId: 'batch-void', movementIds: [] });
    }),
  };
  const orders = {
    bloquear: jest.fn(() => {
      eventos.push('lock-orden');
      return Promise.resolve(orden);
    }),
  };
  const products = {
    costoPromedio: jest
      .fn()
      .mockResolvedValue(
        over.costoActual === undefined ? 1100 : over.costoActual,
      ),
    fijarCostoPromedio: jest.fn().mockResolvedValue(undefined),
  };
  const onHand = {
    llenasTotales: jest.fn().mockResolvedValue(over.llenasHoy ?? 30),
    dondeEstanLasLlenas: jest.fn().mockResolvedValue(over.lugares ?? []),
  };
  const useCase = new VoidPurchaseReceiptUseCase(
    dataSource,
    ledger as never,
    orders as never,
    products as never,
    onHand as never,
  );
  return {
    useCase,
    ledger,
    products,
    orden,
    renglonesOrden,
    recepcion,
    eventos,
  };
}

describe('VoidPurchaseReceiptUseCase', () => {
  it('contraasienta el lote, devuelve lo recibido a la orden y la deja enviada', async () => {
    const { useCase, ledger, orden, renglonesOrden, recepcion, eventos } =
      armar();
    await useCase.execute(REC, { reason: 'Cargado dos veces' }, DIST, USER);
    expect(ledger.contraasentar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        distributorId: DIST,
        batchId: 'batch-1',
        actorUserId: USER,
      }),
    );
    expect(renglonesOrden[0].receivedQuantity).toBe(0);
    expect(orden.status).toBe(E.SENT);
    expect(recepcion.status).toBe(PurchaseReceiptStatus.VOIDED);
    expect(recepcion.voidReason).toBe('Cargado dos veces');
    expect(recepcion.voidBatchId).toBe('batch-void');
    // orden de locks: orden, remito, recién después el ledger
    expect(eventos).toEqual(['lock-orden', 'lock-recepcion', 'contraasiento']);
  });

  it('una orden parcial queda parcial si queda algo recibido', async () => {
    const { useCase, orden, renglonesOrden } = armar({
      ordenStatus: E.RECEIVED,
    });
    renglonesOrden.push({
      gasCylinderId: 'otra',
      quantity: 5,
      receivedQuantity: 5,
    });
    await useCase.execute(REC, { reason: 'x' }, DIST, USER);
    expect(orden.status).toBe(E.PARTIALLY_RECEIVED);
  });

  it('sin compras posteriores restaura EXACTO el promedio previo, con ventas en el medio', async () => {
    // las ventas no cambian el promedio actual (1100): vuelve al 1000 guardado
    const { useCase, products } = armar({ costoActual: 1100 });
    await useCase.execute(REC, { reason: 'x' }, DIST, USER);
    expect(products.fijarCostoPromedio).toHaveBeenCalledWith(
      expect.anything(),
      DIST,
      G1,
      1000,
    );
  });

  it('si fue la única compra, el costo vuelve a null', async () => {
    const { useCase, products } = armar({
      costoActual: 1400,
      previo: { costo: null, existencia: 30 },
      otras: { cantidad: 0, promedio: null, posterior: false },
    });
    await useCase.execute(REC, { reason: 'x' }, DIST, USER);
    expect(products.fijarCostoPromedio).toHaveBeenCalledWith(
      expect.anything(),
      DIST,
      G1,
      null,
    );
  });

  it('con una compra posterior resta lo que esta compra movió', async () => {
    // movió (1400 - 1000) x 10 / 40 = 100; hoy 1250 -> 1150
    const { useCase, products } = armar({
      costoActual: 1250,
      previo: { costo: 1000, existencia: 30 },
      otras: { cantidad: 2, promedio: '1100', posterior: true },
    });
    await useCase.execute(REC, { reason: 'x' }, DIST, USER);
    expect(products.fijarCostoPromedio).toHaveBeenCalledWith(
      expect.anything(),
      DIST,
      G1,
      1150,
    );
  });

  it.each([E.CANCELLED, E.CLOSED_SHORT])(
    'una orden %s conserva su estado al anular la recepción',
    async (estado) => {
      const { useCase, orden, renglonesOrden } = armar({ ordenStatus: estado });
      await useCase.execute(REC, { reason: 'x' }, DIST, USER);
      expect(orden.status).toBe(estado);
      expect(renglonesOrden[0].receivedQuantity).toBe(0);
    },
  );

  it('si las llenas ya no están responde 409 y dice dónde están', async () => {
    const { useCase, recepcion } = armar({
      contraasientoError: new ConflictException('No se puede contraasentar'),
      lugares: [
        { locationName: 'vehículo ABC123', quantity: 8 },
        { locationName: 'Depósito norte', quantity: 2 },
      ],
    });
    const error = await useCase
      .execute(REC, { reason: 'x' }, DIST, USER)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as Error).message).toMatch(
      /recepción N° 4.*10kg: la recepción trajo 10 llenas y hoy hay 8 en vehículo ABC123, 2 en Depósito norte/,
    );
    expect(recepcion.status).toBe(PurchaseReceiptStatus.CONFIRMED);
  });

  it('no anula dos veces', async () => {
    const { useCase, ledger } = armar({ status: PurchaseReceiptStatus.VOIDED });
    await expect(
      useCase.execute(REC, { reason: 'x' }, DIST, USER),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(ledger.contraasentar).not.toHaveBeenCalled();
  });

  it('no anula una recepción pagada', async () => {
    const { useCase, ledger } = armar({ paymentStatus: PaymentStatus.PAID });
    await expect(
      useCase.execute(REC, { reason: 'x' }, DIST, USER),
    ).rejects.toThrow(/figura como pagada/);
    expect(ledger.contraasentar).not.toHaveBeenCalled();
  });

  it('una compra sin orden no toca ninguna orden', async () => {
    const { useCase, eventos } = armar({ conOrden: false });
    await useCase.execute(REC, { reason: 'x' }, DIST, USER);
    expect(eventos).not.toContain('lock-orden');
  });
});
