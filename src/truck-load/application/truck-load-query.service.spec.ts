import { DataSource } from 'typeorm';
import { DeliveryService } from '../../delivery/delivery.service';
import { OrderLookupService } from '../../order/lookup/order-lookup.service';
import { StockOnHandService } from '../../stock/application/stock-on-hand.service';
import { StockQueryService } from '../../stock/application/stock-query.service';
import { CargaNoEncontradaError } from '../domain/errors/truck-load.errors';
import {
  PaymentMethod,
  PaymentStatus,
} from '../../order/entities/order.entity';
import { TruckLoadStatus } from '../domain/truck-load.enums';
import { StockControlSettingsService } from './stock-control-settings.service';
import { TruckLoadQueryService } from './truck-load-query.service';

const CARGA = 'carga-1';
const GARRAFA = 'g-10';
const RETORNO = new Date('2026-10-12T18:00:00Z');

interface Escenario {
  estado?: TruckLoadStatus;
  declarado?: { full: number; empty: number } | null;
  saldos?: Array<{
    gas_cylinder_id: string;
    condition: string;
    quantity: number;
  }>;
  movimientos?: Array<{
    gasCylinderId: string;
    deliveredFull: number;
    collectedEmpty: number;
  }>;
  entregados?: Array<{
    orderId: string;
    totalAmount: number;
    paymentMethod: PaymentMethod;
    paymentStatus: PaymentStatus;
  }>;
  /** Señas ya pagas por pedido. */
  senas?: Record<string, number>;
  tardias?: Array<{
    gasCylinderId: string;
    deliveredFull: number;
    collectedEmpty: number;
  }>;
}

function armar(e: Escenario = {}) {
  const estado = e.estado ?? TruckLoadStatus.RETURNED;
  const declarado =
    e.declarado === undefined ? { full: 20, empty: 2 } : e.declarado;
  const fila = {
    load_id: CARGA,
    number: 1,
    status: estado,
    business_date: '2026-10-12',
    car_id: 'car-1',
    car_patent: 'AB123CD',
    delivery_id: 'del-1',
    driver_name: 'Pedro',
    helper_employee_id: null,
    helper_name: null,
    origin_warehouse_id: 'w-1',
    origin_location_id: 'loc-dep',
    origin_name: 'Central',
    opened_at: new Date('2026-10-12T10:00:00Z'),
    departed_at: null,
    returned_at: RETORNO,
    closed_at: null,
    items_count: 1,
    difference_note: null,
    cancel_reason: null,
    notes: null,
    opened_by_user_id: 'u-1',
    created_at: new Date(),
  };
  const renglon = {
    item_id: 'i-1',
    gas_cylinder_id: GARRAFA,
    type: '10kg',
    loaded_full: 20,
    reloaded_full: 0,
    loaded_empty: 2,
    declared_return_full: declarado?.full ?? null,
    declared_return_empty: declarado?.empty ?? null,
    delivered_full: null,
    collected_empty: null,
    expected_full: null,
    expected_empty: null,
    difference_full: null,
    difference_empty: null,
  };
  const dataSource = {
    manager: {},
    query: jest.fn((sql: string): Promise<unknown[]> => {
      if (sql.includes('FROM "truck_load" l')) return Promise.resolve([fila]);
      if (sql.includes('FROM "truck_load_item"'))
        return Promise.resolve([renglon]);
      if (sql.includes('"deposit_paid"'))
        return Promise.resolve(
          Object.entries(e.senas ?? {}).map(([order_id, sena]) => ({
            order_id,
            sena: String(sena),
          })),
        );
      if (sql.includes('FROM "stock_location"'))
        return Promise.resolve([{ location_id: 'loc-camion' }]);
      return Promise.resolve(
        e.saldos ?? [
          { gas_cylinder_id: GARRAFA, condition: 'full', quantity: 20 },
          { gas_cylinder_id: GARRAFA, condition: 'empty', quantity: 2 },
        ],
      );
    }),
  };
  const onHand = {
    movimientosDelCamion: jest.fn((_m: unknown, _loc: string, desde: Date) =>
      Promise.resolve(
        desde.getTime() === RETORNO.getTime()
          ? (e.tardias ?? [])
          : (e.movimientos ?? []),
      ),
    ),
  };
  const service = new TruckLoadQueryService(
    dataSource as unknown as DataSource,
    {
      entregadosPorVehiculo: jest
        .fn()
        .mockResolvedValue(
          (e.entregados ?? []).map((o) => ({ ...o, deliveredAt: RETORNO })),
        ),
    } as unknown as OrderLookupService,
    {
      movimientos: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    } as unknown as StockQueryService,
    onHand as unknown as StockOnHandService,
    {} as unknown as DeliveryService,
    {} as unknown as StockControlSettingsService,
  );
  return { service, onHand };
}

describe('TruckLoadQueryService.detalle · vista previa del cierre', () => {
  it('lo declarado coincide con lo esperado y el camión lo tiene: no hay diferencia', async () => {
    const { service } = armar();
    const d = await service.detalle(CARGA, 'dist-1');
    expect(d.hayDiferencia).toBe(false);
    expect(d.requiereVolverADeclarar).toBe(false);
    expect(d.items[0]).toMatchObject({
      expectedFull: 20,
      declaredReturnFull: 20,
      differenceFull: 0,
    });
  });

  it('declarar menos de lo esperado es diferencia', async () => {
    const { service } = armar({ declarado: { full: 18, empty: 2 } });
    expect((await service.detalle(CARGA, 'dist-1')).hayDiferencia).toBe(true);
  });

  it('un camión con garrafas que la carga no lista es diferencia aunque lo declarado cuadre', async () => {
    const { service } = armar({
      saldos: [
        { gas_cylinder_id: GARRAFA, condition: 'full', quantity: 20 },
        { gas_cylinder_id: GARRAFA, condition: 'empty', quantity: 2 },
        { gas_cylinder_id: 'g-45', condition: 'full', quantity: 3 },
      ],
    });
    expect((await service.detalle(CARGA, 'dist-1')).hayDiferencia).toBe(true);
  });

  it('sin la vuelta declarada no hay vista previa', async () => {
    const { service } = armar({ declarado: null });
    const d = await service.detalle(CARGA, 'dist-1');
    expect(d.hayDiferencia).toBeNull();
    expect(d.requiereVolverADeclarar).toBe(false);
  });

  it('una entrega posterior a la declaración exige volver a declarar y no calcula diferencia', async () => {
    const { service, onHand } = armar({
      tardias: [
        { gasCylinderId: GARRAFA, deliveredFull: 2, collectedEmpty: 2 },
      ],
    });
    const d = await service.detalle(CARGA, 'dist-1');
    expect(d.requiereVolverADeclarar).toBe(true);
    expect(d.hayDiferencia).toBeNull();
    expect(onHand.movimientosDelCamion).toHaveBeenCalledWith(
      expect.anything(),
      'loc-camion',
      RETORNO,
    );
  });

  it('una carga cerrada no tiene vista previa', async () => {
    const { service } = armar({ estado: TruckLoadStatus.CLOSED });
    const d = await service.detalle(CARGA, 'dist-1');
    expect(d.hayDiferencia).toBeNull();
    expect(d.requiereVolverADeclarar).toBe(false);
  });

  it('una carga ajena al chofer que pregunta es 404', async () => {
    const { service } = armar();
    await expect(
      service.detalle(CARGA, 'dist-1', 'otro-chofer'),
    ).rejects.toBeInstanceOf(CargaNoEncontradaError);
  });
});

describe('TruckLoadQueryService.detalle · efectivo de la jornada con seña', () => {
  const pedido = (
    orderId: string,
    totalAmount: number,
    paymentStatus: PaymentStatus,
    paymentMethod = PaymentMethod.CASH,
  ) => ({ orderId, totalAmount, paymentMethod, paymentStatus });

  it('una reserva de $20.000 con $5.000 de seña paga: el chofer cobra $15.000, no $20.000', async () => {
    const { service } = armar({
      entregados: [pedido('o1', 20000, PaymentStatus.PAID)],
      senas: { o1: 5000 },
    });
    const d = await service.detalle(CARGA, 'dist-1');
    expect(d.cash.cashCollectedAmount).toBe(15000);
    expect(d.orders[0]).toMatchObject({
      totalAmount: 20000,
      remainingBalance: 15000,
    });
  });

  it('el mismo saldo vale para lo impago y lo pendiente de confirmar', async () => {
    const { service } = armar({
      entregados: [
        pedido('o1', 20000, PaymentStatus.UNPAID),
        pedido('o2', 10000, PaymentStatus.PENDING),
        pedido('o3', 8000, PaymentStatus.PAID),
      ],
      senas: { o1: 5000, o2: 2000 },
    });
    const { cash } = await service.detalle(CARGA, 'dist-1');
    expect(cash.unpaidAmount).toBe(15000);
    expect(cash.pendingConfirmationAmount).toBe(8000);
    expect(cash.cashCollectedAmount).toBe(8000);
  });

  it('un pedido sin seña (o con seña sin pagar) cuenta por el total', async () => {
    const { service } = armar({
      entregados: [pedido('o1', 14500, PaymentStatus.PAID)],
      senas: {},
    });
    const d = await service.detalle(CARGA, 'dist-1');
    expect(d.cash.cashCollectedAmount).toBe(14500);
    expect(d.orders[0].remainingBalance).toBe(14500);
  });
});
