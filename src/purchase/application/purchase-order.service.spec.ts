import { ConflictException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { PurchaseOrderStatus as E } from '../domain/purchase.enums';
import { PurchaseOrderService } from './purchase-order.service';

const DIST = 'dddddddd-0000-4000-8000-000000000001';
const OC = 'c0000000-0000-4000-8000-000000000001';
const G1 = '10000000-0000-4000-8000-000000000001';
const WH = 'a0000000-0000-4000-8000-000000000001';
const SUP = 'ssssssss-0000-4000-8000-000000000001';

function armar(estado: E, confirmadas = 0) {
  const orden = {
    purchaseOrderId: OC,
    status: estado,
    issuedAt: null as Date | null,
    cancelReason: null as string | null,
    closeReason: null as string | null,
    totalAmount: 0,
  };
  const qb = {
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(orden),
  };
  const guardados: unknown[] = [];
  const mocks = {
    save: jest.fn((x: unknown) => {
      guardados.push(x);
      return Promise.resolve(x);
    }),
    create: jest.fn((_e: unknown, d: unknown) => ({
      ...(d as object),
      purchaseOrderId: OC,
    })),
    del: jest.fn().mockResolvedValue(undefined),
  };
  const manager = {
    getRepository: jest.fn(() => ({ createQueryBuilder: () => qb })),
    save: mocks.save,
    create: mocks.create,
    insert: jest.fn().mockResolvedValue(undefined),
    delete: mocks.del,
    query: jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('purchase_receipt')
          ? [{ n: confirmadas }]
          : [{ gas_cylinder_id: G1 }],
      ),
    ),
  } as unknown as EntityManager;
  const dataSource = {
    transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
      cb(manager),
    ),
  } as unknown as DataSource;
  const suppliers = { bloquearUsable: jest.fn().mockResolvedValue(undefined) };
  const sequences = { siguienteNumero: jest.fn().mockResolvedValue(12) };
  const locations = { ubicacionDeDeposito: jest.fn().mockResolvedValue({}) };
  const warehouses = {
    asegurarPredeterminado: jest
      .fn()
      .mockResolvedValue({ warehouse: { warehouseId: WH } }),
  };
  const service = new PurchaseOrderService(
    dataSource,
    suppliers as never,
    sequences as never,
    locations as never,
    warehouses as never,
  );
  return { service, orden, manager, mocks, suppliers, sequences };
}

describe('PurchaseOrderService', () => {
  it('crea en borrador con número correlativo y total calculado', async () => {
    const { service, mocks, sequences } = armar(E.DRAFT);
    await service.create(
      {
        supplierId: SUP,
        items: [
          {
            gasCylinderId: G1,
            quantity: 10,
            unitCost: 1250.5,
            emptiesToExchange: 10,
          },
        ],
      },
      DIST,
      'user-1',
    );
    expect(sequences.siguienteNumero).toHaveBeenCalledWith(
      expect.anything(),
      DIST,
      'purchase_order',
    );
    expect(mocks.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        number: 12,
        status: E.DRAFT,
        totalAmount: 12505,
        destinationWarehouseId: WH,
      }),
    );
  });

  it('rechaza una garrafa repetida en la orden', async () => {
    const { service } = armar(E.DRAFT);
    await expect(
      service.create(
        {
          supplierId: SUP,
          items: [
            { gasCylinderId: G1, quantity: 1, unitCost: 1 },
            { gasCylinderId: G1, quantity: 2, unitCost: 1 },
          ],
        },
        DIST,
        'user-1',
      ),
    ).rejects.toThrow(/dos veces/);
  });

  it('una garrafa de otra distribuidora es 404', async () => {
    const { service, manager } = armar(E.DRAFT);
    (manager.query as jest.Mock).mockResolvedValue([]);
    await expect(
      service.create(
        {
          supplierId: SUP,
          items: [{ gasCylinderId: G1, quantity: 1, unitCost: 1 }],
        },
        DIST,
        'u',
      ),
    ).rejects.toThrow(/Garrafa no encontrada/);
  });

  it.each([E.SENT, E.PARTIALLY_RECEIVED, E.RECEIVED, E.CANCELLED])(
    'una orden %s no se edita',
    async (estado) => {
      const { service, mocks } = armar(estado);
      await expect(service.update(OC, { notes: 'x' }, DIST)).rejects.toThrow(
        /Sólo se edita una orden en borrador/,
      );
      expect(mocks.save).not.toHaveBeenCalled();
    },
  );

  it('editar reemplaza los renglones y recalcula el total', async () => {
    const { service, mocks, orden } = armar(E.DRAFT);
    await service.update(
      OC,
      { items: [{ gasCylinderId: G1, quantity: 2, unitCost: 10.25 }] },
      DIST,
    );
    expect(mocks.del).toHaveBeenCalled();
    expect(orden.totalAmount).toBe(20.5);
  });

  it('enviar pasa de borrador a enviada y sella la fecha', async () => {
    const { service, orden } = armar(E.DRAFT);
    await service.send(OC, DIST);
    expect(orden.status).toBe(E.SENT);
    expect(orden.issuedAt).toBeInstanceOf(Date);
  });

  it('no se envía dos veces', async () => {
    const { service } = armar(E.SENT);
    await expect(service.send(OC, DIST)).rejects.toThrow(
      /está enviada: no puede pasar a enviada/,
    );
  });

  it('cancelar guarda el motivo', async () => {
    const a = armar(E.SENT);
    await a.service.cancel(OC, { reason: 'Sin stock' }, DIST);
    expect(a.orden.status).toBe(E.CANCELLED);
    expect(a.orden.cancelReason).toBe('Sin stock');
  });

  it('con recepciones confirmadas (aunque sean sólo de vacías) cancelar es 409', async () => {
    const a = armar(E.SENT, 1);
    await expect(
      a.service.cancel(OC, { reason: 'x' }, DIST),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(a.orden.status).toBe(E.SENT);
    const b = armar(E.PARTIALLY_RECEIVED, 2);
    await expect(b.service.cancel(OC, { reason: 'x' }, DIST)).rejects.toThrow(
      /2 recepción\(es\) confirmada\(s\).*cerrala con faltante/,
    );
  });

  it('una orden recibida o cancelada no se cancela', async () => {
    const b = armar(E.RECEIVED);
    await expect(b.service.cancel(OC, { reason: 'x' }, DIST)).rejects.toThrow(
      /no puede pasar a cancelada/,
    );
  });

  it('cerrar con faltante sólo vale para una orden parcialmente recibida', async () => {
    const a = armar(E.PARTIALLY_RECEIVED, 1);
    await a.service.closeShort(OC, { reason: 'La planta no repone' }, DIST);
    expect(a.orden.status).toBe(E.CLOSED_SHORT);
    expect(a.orden.closeReason).toBe('La planta no repone');
    for (const estado of [E.DRAFT, E.SENT, E.RECEIVED, E.CANCELLED]) {
      const o = armar(estado);
      await expect(
        o.service.closeShort(OC, { reason: 'x' }, DIST),
      ).rejects.toThrow(/no puede pasar a cerrada con faltante/);
    }
  });
});
