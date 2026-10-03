/**
 * Tests de integración: cada renglón del pedido expone el precio con el que se
 * vendió (`unit_price`, `subtotal`), aunque el catálogo cambie después.
 */
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  TestEnv,
  createTestApp,
  sembrarClienteAutenticado,
  truncateAllTables,
} from './setup/test-env';
import { GasCylinder } from '../../src/gascylinder/entities/gascylinder.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';

interface RenglonJson {
  quantity: number;
  unit_price: number;
  subtotal: number;
  gas_cylinder: { price: number } | null;
}

interface PedidoJson {
  order_id: string;
  order_items: RenglonJson[];
}

describe('Orders precio del renglón (e2e)', () => {
  let env: TestEnv;
  let dataSource: DataSource;

  beforeAll(async () => {
    env = await createTestApp();
    dataSource = env.app.get(DataSource);
  }, 120000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
  });

  it('GET /orders/:id y el listado del cliente traen el precio vendido, no el vigente', async () => {
    const { user, distributor, headers } = await sembrarClienteAutenticado(
      env.app,
    );
    const cylinder = (await dataSource.getRepository(GasCylinder).save({
      type: '10kg',
      price: 1000,
      stock: 10,
      weight: 10,
      isActive: true,
      distributorId: distributor.distributorId,
    } as Partial<GasCylinder>)) as GasCylinder;
    const address = (await dataSource.getRepository(UserAddress).save({
      userId: user.userId,
      street: 'Av. Test 123',
      city: 'CABA',
      latitude: '-34.6037',
      longitude: '-58.3816',
    } as Partial<UserAddress>)) as UserAddress;

    const creado = await request(env.app.getHttpServer())
      .post('/orders')
      .set(headers)
      .send({
        customerId: user.userId,
        addressId: address.addressId,
        paymentMethod: 'cash',
        items: [
          {
            gasCylinderId: cylinder.gasCylinderId,
            quantity: 2,
            unitPrice: 1000,
          },
        ],
      })
      .expect(201);
    const pedidoCreado = creado.body as PedidoJson;

    // El catálogo sube de precio después de la venta.
    await dataSource
      .getRepository(GasCylinder)
      .update({ gasCylinderId: cylinder.gasCylinderId }, { price: 1500 });

    const uno = await request(env.app.getHttpServer())
      .get(`/orders/${pedidoCreado.order_id}`)
      .set(headers)
      .expect(200);
    const [renglon] = (uno.body as PedidoJson).order_items;
    expect(renglon.quantity).toBe(2);
    expect(renglon.unit_price).toBe(1000);
    expect(renglon.subtotal).toBe(2000);
    expect(renglon.gas_cylinder?.price).toBe(1500);

    const lista = await request(env.app.getHttpServer())
      .get(`/orders/customer/${user.userId}`)
      .set(headers)
      .expect(200);
    const pedidos = (lista.body as { orders: PedidoJson[] }).orders;
    expect(pedidos[0].order_items[0].unit_price).toBe(1000);
    expect(pedidos[0].order_items[0].subtotal).toBe(2000);
  });
});
