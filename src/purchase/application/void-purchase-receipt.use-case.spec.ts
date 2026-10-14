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

interface FilaDeHistorial {
  receipt_id: string;
  number: number;
  status: string;
  created_at: Date;
  voided_at: Date | null;
  quantity_full: number;
  unit_cost: string;
  previous_average_cost: string | null;
  previous_on_hand: number | null;
  previous_on_hand_at?: Date | null;
}

const ANTES = new Date('2026-10-01T10:00:00Z');
const AHORA_DE_LA_BASE = new Date('2026-10-12T15:00:00Z');

const fila = (over: Partial<FilaDeHistorial>): FilaDeHistorial => ({
  receipt_id: 'otra',
  number: 3,
  status: 'confirmed',
  created_at: ANTES,
  voided_at: null,
  quantity_full: 10,
  unit_cost: '1000',
  previous_average_cost: null,
  previous_on_hand: 20,
  ...over,
});

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
    /** Recepciones de llenas de la garrafa, además de la que se anula. */
    otras?: FilaDeHistorial[];
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
    query: jest.fn((sql: string) => {
      if (sql.includes('clock_timestamp()')) {
        return Promise.resolve([{ ahora: AHORA_DE_LA_BASE }]);
      }
      if (sql.includes('"purchase_receipt_item"')) {
        const esta = fila({
          receipt_id: REC,
          number: 4,
          created_at: new Date('2026-10-02T10:00:00Z'),
          quantity_full: itemsRecepcion[0].quantityFull,
          unit_cost: String(itemsRecepcion[0].unitCost),
          previous_average_cost:
            itemsRecepcion[0].previousAverageCost === null
              ? null
              : String(itemsRecepcion[0].previousAverageCost),
          previous_on_hand: itemsRecepcion[0].previousOnHand,
        });
        const todas = [...(over.otras ?? [fila({})]), esta];
        return Promise.resolve(todas.sort((a, b) => a.number - b.number));
      }
      return Promise.resolve([{ type: '10kg' }]);
    }),
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

  it('sin compras posteriores deja el promedio de las anteriores, con ventas en el medio', async () => {
    // las ventas no cambian el promedio actual (1100): queda el de la compra anterior
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
      otras: [],
    });
    await useCase.execute(REC, { reason: 'x' }, DIST, USER);
    expect(products.fijarCostoPromedio).toHaveBeenCalledWith(
      expect.anything(),
      DIST,
      G1,
      null,
    );
  });

  it('con una compra posterior la repite sin las llenas de la anulada', async () => {
    // R3: 20 llenas sin costo + 10 a 1000 -> 1000. R4 (la que se anula) 10 a 1400.
    // R5 vio 40 llenas (20 + 10 + 10): sin R4 son 30 -> (30x1000 + 10x1100) / 40.
    const { useCase, products } = armar({
      costoActual: 1250,
      previo: { costo: 1000, existencia: 30 },
      otras: [
        fila({}),
        fila({
          receipt_id: 'r5',
          number: 5,
          created_at: new Date('2026-10-03T10:00:00Z'),
          unit_cost: '1100',
          previous_average_cost: '1250',
          previous_on_hand: 40,
        }),
      ],
    });
    await useCase.execute(REC, { reason: 'x' }, DIST, USER);
    expect(products.fijarCostoPromedio).toHaveBeenCalledWith(
      expect.anything(),
      DIST,
      G1,
      1025,
    );
  });

  it('una anulación previa a la compra siguiente no se descuenta dos veces', async () => {
    // R3 se anuló (antes de crearse R5): el 40 guardado de R5 ya no la cuenta,
    // sólo hay que sacar la de R4: 30 llenas -> igual que arriba, con R3 anulada.
    const { useCase, products } = armar({
      costoActual: 1250,
      otras: [
        fila({
          status: 'voided',
          voided_at: new Date('2026-10-02T12:00:00Z'),
        }),
        fila({
          receipt_id: 'r5',
          number: 5,
          created_at: new Date('2026-10-03T10:00:00Z'),
          unit_cost: '1100',
          previous_average_cost: '1250',
          previous_on_hand: 30,
        }),
      ],
    });
    await useCase.execute(REC, { reason: 'x' }, DIST, USER);
    // R5 sola: existencia previa 30 - 10 (R4 anulada ahora) = 20, sin costo previo -> 1100
    expect(products.fijarCostoPromedio).toHaveBeenCalledWith(
      expect.anything(),
      DIST,
      G1,
      1100,
    );
  });

  it('una recepción que leyó su existencia después de la anulación no la resta de nuevo, aunque su transacción haya empezado antes', async () => {
    // R5 empezó (createdAt) antes de la anulación pero leyó su existencia (20, ya sin R4) después
    const { useCase, products } = armar({
      costoActual: 1100,
      otras: [
        fila({}),
        fila({
          receipt_id: 'r5',
          number: 5,
          created_at: new Date(AHORA_DE_LA_BASE.getTime() - 1000),
          previous_on_hand_at: new Date(AHORA_DE_LA_BASE.getTime() + 1000),
          unit_cost: '1100',
          previous_average_cost: '1250',
          previous_on_hand: 20,
        }),
      ],
    });
    await useCase.execute(REC, { reason: 'x' }, DIST, USER);
    // (20 x 1000 + 10 x 1100) / 30
    expect(products.fijarCostoPromedio).toHaveBeenCalledWith(
      expect.anything(),
      DIST,
      G1,
      1033.33,
    );
  });

  it('una recepción vieja sin existencia guardada deja el promedio como está', async () => {
    const { useCase, products } = armar({
      costoActual: 1250,
      otras: [fila({ previous_on_hand: null })],
    });
    await useCase.execute(REC, { reason: 'x' }, DIST, USER);
    expect(products.fijarCostoPromedio).not.toHaveBeenCalled();
  });

  it('la anulación se fecha con el reloj de la base', async () => {
    const { useCase, recepcion } = armar();
    await useCase.execute(REC, { reason: 'x' }, DIST, USER);
    expect((recepcion as { voidedAt?: Date }).voidedAt).toBe(AHORA_DE_LA_BASE);
  });

  it('un motivo largo no desborda las notas del libro (300): se corta con puntos suspensivos y el motivo queda entero', async () => {
    const { useCase, ledger, recepcion } = armar();
    const motivo = 'm'.repeat(500);
    await useCase.execute(REC, { reason: motivo }, DIST, USER);
    const [, args] = ledger.contraasentar.mock.calls[0] as unknown as [
      unknown,
      { notes: string },
    ];
    expect(args.notes).toHaveLength(300);
    expect(args.notes.endsWith('…')).toBe(true);
    expect(recepcion.voidReason).toBe(motivo);
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
