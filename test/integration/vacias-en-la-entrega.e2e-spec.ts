import { DataSource } from 'typeorm';
import { createTestApp, TestEnv, truncateAllTables } from './setup/test-env';
import { conIdempotencia } from './setup/con-idempotencia';
import { Finanzas } from './setup/finanzas';
import { forzarEstado } from './setup/bypass';
import { OrderItem } from '../../src/order/entities/order-item.entity';
import { UpdateOrderStatusUseCase } from '../../src/order/application/update-order-status.use-case';
import { OrderStatus } from '../../src/order/entities/order.entity';
import { WarehouseService } from '../../src/stock/application/warehouse.service';
import { StockLedgerPort } from '../../src/stock/domain/ports/stock-ledger.port';
import {
  StockCondition,
  StockMovementReason,
  StockReferenceType,
} from '../../src/stock/domain/stock.enums';

/** F35 E4: vacías reales, declaración del chofer y aviso de faltante. */
describe('Vacías en la entrega (Postgres real)', () => {
  let env: TestEnv;
  let ds: DataSource;
  let f: Finanzas;

  beforeAll(async () => {
    env = await createTestApp();
    ds = env.app.get(DataSource);
    f = new Finanzas(env);
  }, 240000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
  });

  async function escenario() {
    const e = await f.distribuidora();
    const chofer = await f.chofer(e.distributorId, 'Chofer vacías');
    const otroChofer = await f.chofer(e.distributorId, 'Otro chofer');
    const cliente = await f.cliente('Cliente vacías');
    const pedido = await f.pedidoEntregado(e, {
      chofer,
      cliente,
      cantidad: 3,
    });
    await ds
      .getRepository(OrderItem)
      .update({ orderId: pedido.orderId }, { containersCharged: 1 });
    await forzarEstado(
      ds,
      `UPDATE "order" SET status = 'on_the_way', "deliveredAt" = NULL WHERE order_id = $1`,
      [pedido.orderId],
    );
    const deposito = await env.app
      .get(WarehouseService)
      .asegurarPredeterminado(e.distributorId);
    await ds.transaction((manager) =>
      env.app.get(StockLedgerPort).aplicar(manager, {
        distributorId: e.distributorId,
        referenceType: StockReferenceType.INITIAL,
        referenceId: null,
        actorUserId: null,
        movimientos: [
          {
            gasCylinderId: e.garrafa.gasCylinderId,
            quantity: 3,
            from: null,
            to: {
              locationId: deposito.locationId,
              condition: StockCondition.FULL,
            },
            reason: StockMovementReason.INITIAL_COUNT,
          },
        ],
      }),
    );
    return { e, chofer, otroChofer, pedido };
  }

  it('sin declaración recoge las 2 esperadas y no crea faltante', async () => {
    const { e, pedido } = await escenario();
    await env.app
      .get(UpdateOrderStatusUseCase)
      .execute(
        pedido.orderId,
        OrderStatus.DELIVERED,
        undefined,
        undefined,
        undefined,
      );
    const [movement] = await ds.query<Array<{ quantity: number }>>(
      `SELECT quantity FROM stock_movement WHERE reference_id = $1 AND reason = 'empty_collected'`,
      [pedido.orderId],
    );
    expect(movement.quantity).toBe(2);
    const notices = await ds.query<Array<{ count: string }>>(
      `SELECT count(*) FROM admin_notification WHERE kind = 'empties_shortfall' AND distributor_id = $1`,
      [e.distributorId],
    );
    expect(Number(notices[0].count)).toBe(0);
  });

  it('declara una vacía, recoge una y avisa una sola vez', async () => {
    const { e, chofer, pedido } = await escenario();
    const response = await conIdempotencia(env.app.getHttpServer())
      .patch(`/v2/orders/${pedido.orderId}/empties`)
      .set(chofer.headers)
      .send({
        items: [{ gasCylinderId: e.garrafa.gasCylinderId, emptiesReceived: 1 }],
      })
      .expect(200);
    const cuerpo = response.body as {
      order_items: Array<{ emptiesExpected: number; emptiesReceived: number }>;
    };
    expect(cuerpo.order_items[0]).toMatchObject({
      emptiesExpected: 2,
      emptiesReceived: 1,
    });
    await env.app
      .get(UpdateOrderStatusUseCase)
      .execute(pedido.orderId, OrderStatus.DELIVERED);
    // La persistencia del listener es asíncrona: esperamos el hecho observado,
    // no un turno arbitrario del event loop.
    await esperar(async () => {
      const [{ count }] = await ds.query<Array<{ count: string }>>(
        `SELECT count(*) FROM admin_notification WHERE kind = 'empties_shortfall' AND distributor_id = $1`,
        [e.distributorId],
      );
      return Number(count) === 1;
    });
    // Reintentar la misma entrega vuelve a emitir el aviso, pero la clave de
    // deduplicación debe conservar un único registro.
    await env.app
      .get(UpdateOrderStatusUseCase)
      .execute(pedido.orderId, OrderStatus.DELIVERED);
    await esperar(async () => {
      const [{ count }] = await ds.query<Array<{ count: string }>>(
        `SELECT count(*) FROM admin_notification WHERE kind = 'empties_shortfall' AND distributor_id = $1`,
        [e.distributorId],
      );
      return Number(count) === 1;
    });
    const [movement] = await ds.query<Array<{ quantity: number }>>(
      `SELECT quantity FROM stock_movement WHERE reference_id = $1 AND reason = 'empty_collected'`,
      [pedido.orderId],
    );
    expect(movement.quantity).toBe(1);
    const notices = await ds.query<Array<{ count: string }>>(
      `SELECT count(*) FROM admin_notification WHERE kind = 'empties_shortfall' AND distributor_id = $1`,
      [e.distributorId],
    );
    expect(Number(notices[0].count)).toBe(1);
  });

  it('rechaza otro chofer, otro estado y un valor fuera del rango', async () => {
    const { e, chofer, otroChofer, pedido } = await escenario();
    const http = conIdempotencia(env.app.getHttpServer());
    const body = {
      items: [{ gasCylinderId: e.garrafa.gasCylinderId, emptiesReceived: 1 }],
    };
    await http
      .patch(`/v2/orders/${pedido.orderId}/empties`)
      .set(otroChofer.headers)
      .send(body)
      .expect(403);
    await http
      .patch(`/v2/orders/${pedido.orderId}/empties`)
      .set(chofer.headers)
      .send({
        items: [{ gasCylinderId: e.garrafa.gasCylinderId, emptiesReceived: 3 }],
      })
      .expect(400);
    await forzarEstado(
      ds,
      `UPDATE "order" SET status = 'pending' WHERE order_id = $1`,
      [pedido.orderId],
    );
    await http
      .patch(`/v2/orders/${pedido.orderId}/empties`)
      .set(chofer.headers)
      .send(body)
      .expect(409);
    await forzarEstado(
      ds,
      `UPDATE "order" SET status = 'delivered', "deliveredAt" = now() WHERE order_id = $1`,
      [pedido.orderId],
    );
    await http
      .patch(`/v2/orders/${pedido.orderId}/empties`)
      .set(chofer.headers)
      .send(body)
      .expect(409);
  });
});

async function esperar(
  condicion: () => boolean | Promise<boolean>,
  ms = 5000,
): Promise<void> {
  const limite = Date.now() + ms;
  while (!(await condicion())) {
    if (Date.now() >= limite) {
      throw new Error('Se agotó la espera del listener de avisos');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}
