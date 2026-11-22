/**
 * Triggers `sin-transferencia` contra Postgres real: la base rechaza un alta o
 * un cambio NUEVO hacia transferencia y deja operar pedidos históricos.
 *
 * La base de pruebas arranca con `splg.bypass_transferencia = on` (los fixtures
 * siembran pedidos históricos). Acá la regla se enciende con `SET LOCAL ... off`
 * dentro de cada transacción, así que lo que se prueba es el trigger real de la
 * migración `SinTransferencia`.
 */
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  Order,
  OrderStatus,
  PaymentMethod,
} from '../../src/order/entities/order.entity';
import { fechasSegunEstado } from './setup/pedido-valido';
import { TestEnv, createTestApp } from './setup/test-env';
import { sembrarEscenario } from './matriz-http/matriz';
import {
  EscenarioT2,
  sembrarBaseT2,
  sembrarPedido,
} from './matriz-http/t2-base';

describe('Base: sin transferencia (trigger de la migración)', () => {
  let env: TestEnv;
  let ctx: EscenarioT2;
  let ds: DataSource;

  beforeAll(async () => {
    env = await createTestApp();
    ds = env.app.get(DataSource);
    ctx = await sembrarBaseT2(env.app, await sembrarEscenario(env.app));
  }, 300000);

  afterAll(async () => {
    await env.cleanup();
  });

  /** Corre `trabajo` con la regla encendida (bypass apagado sólo en esta transacción). */
  const conRegla = <T>(trabajo: (m: EntityManager) => Promise<T>): Promise<T> =>
    ds.transaction(async (m) => {
      await m.query(`SET LOCAL splg.bypass_transferencia = 'off'`);
      return trabajo(m);
    });

  const ERROR_DEL_TRIGGER = {
    code: '23514',
    constraint: 'CHK_order_sin_transferencia',
  };

  it('un INSERT con transferencia es rechazado', async () => {
    const modelo = await ds
      .getRepository(Order)
      .findOneByOrFail({ orderId: await sembrarPedido(ctx) });
    await expect(
      conRegla((m) =>
        m.getRepository(Order).insert({
          ...modelo,
          orderId: randomUUID(),
          paymentMethod: PaymentMethod.TRANSFER,
        }),
      ),
    ).rejects.toMatchObject(ERROR_DEL_TRIGGER);
  });

  it('un UPDATE que pasa un pedido de efectivo a transferencia es rechazado', async () => {
    const id = await sembrarPedido(ctx);
    await expect(
      conRegla((m) =>
        m.update(
          Order,
          { orderId: id },
          {
            paymentMethod: PaymentMethod.TRANSFER,
          },
        ),
      ),
    ).rejects.toMatchObject(ERROR_DEL_TRIGGER);
    const o = await ds.getRepository(Order).findOneByOrFail({ orderId: id });
    expect(o.paymentMethod).toBe(PaymentMethod.CASH);
  });

  describe('pedido histórico con transferencia', () => {
    it('cambia de estado, se cobra y se cancela con la regla encendida', async () => {
      const id = await sembrarPedido(ctx, { metodo: PaymentMethod.TRANSFER });
      const historico = await ds
        .getRepository(Order)
        .findOneByOrFail({ orderId: id });
      expect(historico.paymentMethod).toBe(PaymentMethod.TRANSFER);

      await conRegla(async (m) => {
        await m.update(
          Order,
          { orderId: id },
          {
            status: OrderStatus.CANCELLED,
            ...fechasSegunEstado(OrderStatus.CANCELLED),
          },
        );
      });
      const cancelado = await ds
        .getRepository(Order)
        .findOneByOrFail({ orderId: id });
      expect(cancelado.status).toBe(OrderStatus.CANCELLED);
      expect(cancelado.paymentMethod).toBe(PaymentMethod.TRANSFER);
    });

    it('un UPDATE que lo deja en transferencia como estaba pasa; a efectivo también', async () => {
      const id = await sembrarPedido(ctx, { metodo: PaymentMethod.TRANSFER });
      await conRegla((m) =>
        m.update(
          Order,
          { orderId: id },
          {
            paymentMethod: PaymentMethod.TRANSFER,
          },
        ),
      );
      await conRegla((m) =>
        m.update(Order, { orderId: id }, { paymentMethod: PaymentMethod.CASH }),
      );
      const o = await ds.getRepository(Order).findOneByOrFail({ orderId: id });
      expect(o.paymentMethod).toBe(PaymentMethod.CASH);
    });

    it('un pedido entregado con transferencia se marca pagado (cobro)', async () => {
      const id = await sembrarPedido(ctx, {
        metodo: PaymentMethod.TRANSFER,
        estado: OrderStatus.DELIVERED,
      });
      await conRegla(async (m) => {
        await m.query(`SELECT set_config('splg.bypass_saldos', 'on', true)`);
        await m.query(
          `SELECT set_config('splg.bypass_transiciones', 'on', true)`,
        );
        await m.update(
          Order,
          { orderId: id },
          { paymentStatus: 'paid' as never },
        );
      });
      const o = await ds.getRepository(Order).findOneByOrFail({ orderId: id });
      expect(o.paymentStatus).toBe('paid');
      expect(o.paymentMethod).toBe(PaymentMethod.TRANSFER);
    });
  });
});
