import type { DataSource } from 'typeorm';
import type { GasCylinderPhotoService } from '../../gascylinder/gascylinder-photo.service';
import { PurchaseOrderStatus } from '../domain/purchase.enums';
import { PurchaseQueryService } from './purchase-query.service';

const ORDEN = 'o-1';
const RECEPCION = 'r-1';
const G1 = 'g-1';
const G2 = 'g-2';

const filaDeOrden = {
  purchase_order_id: ORDEN,
  number: 1,
  supplier_id: 's-1',
  supplier_name: 'Proveedor',
  destination_warehouse_id: 'w-1',
  warehouse_name: 'Central',
  status: PurchaseOrderStatus.SENT,
  issued_at: null,
  expected_date: null,
  total_amount: '100',
  cancel_reason: null,
  close_reason: null,
  notes: null,
  ordered: 10,
  received: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const renglonesDeOrden = [
  {
    item_id: 'i-1',
    gas_cylinder_id: G1,
    type: '10kg',
    quantity: 10,
    unit_cost: '10',
    empties_to_exchange: 0,
    received_quantity: 0,
  },
  {
    item_id: 'i-2',
    gas_cylinder_id: G2,
    type: '15kg',
    quantity: 5,
    unit_cost: '20',
    empties_to_exchange: 0,
    received_quantity: 0,
  },
];

const filaDeRecepcion = {
  receipt_id: RECEPCION,
  number: 1,
  supplier_id: 's-1',
  supplier_name: 'Proveedor',
  purchase_order_id: null,
  po_number: null,
  warehouse_id: 'w-1',
  warehouse_name: 'Central',
  supplier_document_type: 'remito',
  supplier_document_number: '0001-1',
  received_at: new Date(),
  total_amount: '100',
  payment_status: 'pending',
  status: 'confirmed',
  notes: null,
  void_reason: null,
  voided_at: null,
  received_by_user_id: 'u-1',
  batch_id: 'b-1',
  void_batch_id: null,
  cash_movement_id: null,
  createdAt: new Date(),
};

const renglonesDeRecepcion = [
  {
    item_id: 'ri-1',
    gas_cylinder_id: G1,
    type: '10kg',
    quantity_full: 10,
    quantity_empty_out: 10,
    unit_cost: '10',
  },
  {
    item_id: 'ri-2',
    gas_cylinder_id: G2,
    type: '15kg',
    quantity_full: 5,
    quantity_empty_out: 5,
    unit_cost: '20',
  },
];

function armar(fotos: Array<[string, string | null]> = []) {
  const query = jest.fn((sql: string): Promise<unknown[]> => {
    if (sql.includes('FROM "purchase_order_item" i'))
      return Promise.resolve(renglonesDeOrden);
    if (sql.includes('FROM "purchase_receipt_item" i'))
      return Promise.resolve(renglonesDeRecepcion);
    if (sql.includes('FROM (') && sql.includes('"purchase_receipt" r'))
      return Promise.resolve([filaDeRecepcion]);
    if (sql.includes('FROM "purchase_receipt" r')) return Promise.resolve([]);
    if (sql.includes('FROM "purchase_order" o'))
      return Promise.resolve([filaDeOrden]);
    if (sql.includes('FROM "purchase_order"'))
      return Promise.resolve([
        {
          purchase_order_id: ORDEN,
          number: 1,
          status: PurchaseOrderStatus.SENT,
        },
      ]);
    throw new Error(sql);
  });
  const productos = {
    urlsPorId: jest.fn(() => Promise.resolve(new Map(fotos))),
  };
  const service = new PurchaseQueryService(
    { query } as unknown as DataSource,
    productos as unknown as GasCylinderPhotoService,
  );
  return { service, productos };
}

describe('PurchaseQueryService · foto del producto', () => {
  it('orden: cada renglón lleva la foto firmada de su producto, o null', async () => {
    const { service, productos } = armar([[G1, 'https://s3.test/g1.jpg']]);
    const r = await service.orden(ORDEN, 'd1');
    expect(r.items.map((i) => i.gasCylinderPhotoUrl)).toEqual([
      'https://s3.test/g1.jpg',
      null,
    ]);
    expect(productos.urlsPorId).toHaveBeenCalledTimes(1);
    expect(productos.urlsPorId).toHaveBeenCalledWith('d1', [G1, G2]);
  });

  it('orden sin ninguna foto: todo null y la orden sigue igual', async () => {
    const { service } = armar([]);
    const r = await service.orden(ORDEN, 'd1');
    expect(r.items.map((i) => i.gasCylinderPhotoUrl)).toEqual([null, null]);
    expect(r.items[0].gasCylinderType).toBe('10kg');
  });

  it('pendiente: cada renglón pendiente lleva la foto del producto', async () => {
    const { service } = armar([[G2, 'https://s3.test/g2.jpg']]);
    const r = await service.pendiente(ORDEN, 'd1');
    expect(r.items.map((i) => i.gasCylinderPhotoUrl)).toEqual([
      null,
      'https://s3.test/g2.jpg',
    ]);
  });

  it('recepción: cada renglón lleva la foto firmada de su producto, o null', async () => {
    const { service, productos } = armar([[G1, 'https://s3.test/g1.jpg']]);
    const r = await service.recepcion(RECEPCION, 'd1');
    expect(r.items.map((i) => i.gasCylinderPhotoUrl)).toEqual([
      'https://s3.test/g1.jpg',
      null,
    ]);
    expect(productos.urlsPorId).toHaveBeenCalledTimes(1);
    expect(productos.urlsPorId).toHaveBeenCalledWith('d1', [G1, G2]);
  });

  it('recepción sin fotos: todo null', async () => {
    const { service } = armar([]);
    const r = await service.recepcion(RECEPCION, 'd1');
    expect(r.items.map((i) => i.gasCylinderPhotoUrl)).toEqual([null, null]);
  });
});
