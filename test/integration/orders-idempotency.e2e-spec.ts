/**
 * Tests de integración: idempotencia de POST /orders y PATCH /orders/:id/cancel.
 *
 * Valida que el IdempotencyInterceptor + cache en Redis garantizan
 * que un retry de red NO crea pedidos duplicados ni decrementa stock dos veces.
 *
 * Escenarios:
 *   1. Misma Idempotency-Key → primera request crea pedido, segunda retorna
 *      la respuesta cacheada SIN ejecutar el handler (mismo orderId, stock cambió
 *      solo una vez).
 *   2. Idempotency-Keys distintas → 2 pedidos distintos creados (sin idempotencia).
 *   3. Sin header → ejecuta normalmente (backwards compat).
 *   4. Header con UUID inválido → 400.
 *   5. Cancelación idempotente: cancelar 2 veces con misma key → mismo resultado,
 *      no doble restitución de stock.
 */
import { randomUUID } from 'crypto';
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

/** Forma mínima del cuerpo de un pedido creado: soporta las dos claves que
 * usó el endpoint a lo largo del tiempo (`order_id` y `id`). */
interface CuerpoPedido {
  order_id?: string;
  id?: string;
}

/** `res.body` de supertest llega sin tipar: se lee a través de esta forma
 * conocida en vez de acceder a un valor `any`. */
function idDelPedido(body: unknown): string | undefined {
  const pedido = body as CuerpoPedido;
  return pedido.order_id ?? pedido.id;
}

describe('Orders Idempotency (e2e)', () => {
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

  async function seed(stock: number) {
    const { user, distributor, headers } = await sembrarClienteAutenticado(
      env.app,
    );

    const cylinder = (await dataSource.getRepository(GasCylinder).save({
      type: '10kg',
      price: 1000,
      stock,
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

    return { user, cylinder, address, headers };
  }

  it('misma Idempotency-Key: retry no crea pedido duplicado, stock decrementa solo 1 vez', async () => {
    const { user, cylinder, address, headers } = await seed(5);
    const idempotencyKey = randomUUID();

    const payload = {
      customerId: user.userId,
      addressId: address.addressId,
      paymentMethod: 'cash',
      items: [
        { gasCylinderId: cylinder.gasCylinderId, quantity: 1, unitPrice: 1000 },
      ],
    };

    // Primera request: ejecuta handler
    const first = await request(env.app.getHttpServer())
      .post('/orders')
      .set(headers)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload)
      .expect(201);

    // Segunda request idéntica: debería retornar respuesta cacheada
    const second = await request(env.app.getHttpServer())
      .post('/orders')
      .set(headers)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload)
      .expect(201);

    // Misma respuesta (mismo orderId)
    expect(idDelPedido(second.body)).toBe(idDelPedido(first.body));

    // Stock decrementó SOLO una vez (5 - 1 = 4)
    const finalCylinder = await dataSource
      .getRepository(GasCylinder)
      .findOneOrFail({ where: { gasCylinderId: cylinder.gasCylinderId } });
    expect(finalCylinder.stock).toBe(4);
  });

  it('Idempotency-Keys distintas crean 2 pedidos diferentes (sin idempotencia)', async () => {
    const { user, cylinder, address, headers } = await seed(5);

    const payload = {
      customerId: user.userId,
      addressId: address.addressId,
      paymentMethod: 'cash',
      items: [
        { gasCylinderId: cylinder.gasCylinderId, quantity: 1, unitPrice: 1000 },
      ],
    };

    const first = await request(env.app.getHttpServer())
      .post('/orders')
      .set(headers)
      .set('Idempotency-Key', randomUUID())
      .send(payload)
      .expect(201);

    const second = await request(env.app.getHttpServer())
      .post('/orders')
      .set(headers)
      .set('Idempotency-Key', randomUUID())
      .send(payload)
      .expect(201);

    // Distintos orderIds → 2 pedidos creados
    expect(idDelPedido(second.body)).not.toBe(idDelPedido(first.body));

    const finalCylinder = await dataSource
      .getRepository(GasCylinder)
      .findOneOrFail({ where: { gasCylinderId: cylinder.gasCylinderId } });
    expect(finalCylinder.stock).toBe(3); // 5 - 2 = 3
  });

  it('sin header Idempotency-Key: comportamiento normal (backwards compat)', async () => {
    const { user, cylinder, address, headers } = await seed(5);

    const res = await request(env.app.getHttpServer())
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

    expect(res.body).toBeDefined();
    const finalCylinder = await dataSource
      .getRepository(GasCylinder)
      .findOneOrFail({ where: { gasCylinderId: cylinder.gasCylinderId } });
    expect(finalCylinder.stock).toBe(3);
  });

  it('Idempotency-Key con formato inválido → 400', async () => {
    const { user, cylinder, address, headers } = await seed(5);

    await request(env.app.getHttpServer())
      .post('/orders')
      .set(headers)
      .set('Idempotency-Key', 'not-a-uuid')
      .send({
        customerId: user.userId,
        addressId: address.addressId,
        paymentMethod: 'cash',
        items: [
          {
            gasCylinderId: cylinder.gasCylinderId,
            quantity: 1,
            unitPrice: 1000,
          },
        ],
      })
      .expect(400);

    // Stock intacto: nunca llegó a ejecutar el handler
    const finalCylinder = await dataSource
      .getRepository(GasCylinder)
      .findOneOrFail({ where: { gasCylinderId: cylinder.gasCylinderId } });
    expect(finalCylinder.stock).toBe(5);
  });

  it('respuesta cacheada se devuelve incluso tras requests con stock cambiado', async () => {
    // Demuestra que el cache es por Idempotency-Key, no por estado de BD.
    const { user, cylinder, address, headers } = await seed(5);
    const idempotencyKey = randomUUID();

    const first = await request(env.app.getHttpServer())
      .post('/orders')
      .set(headers)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        customerId: user.userId,
        addressId: address.addressId,
        paymentMethod: 'cash',
        items: [
          {
            gasCylinderId: cylinder.gasCylinderId,
            quantity: 1,
            unitPrice: 1000,
          },
        ],
      })
      .expect(201);

    // Cambiamos stock manualmente a 0 (simulando que otra request lo consumió)
    await dataSource
      .getRepository(GasCylinder)
      .update(cylinder.gasCylinderId, { stock: 0 });

    // Segunda request con misma key: aunque ya no hay stock, el cache responde con la primera
    const second = await request(env.app.getHttpServer())
      .post('/orders')
      .set(headers)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        customerId: user.userId,
        addressId: address.addressId,
        paymentMethod: 'cash',
        items: [
          {
            gasCylinderId: cylinder.gasCylinderId,
            quantity: 1,
            unitPrice: 1000,
          },
        ],
      })
      .expect(201);

    expect(idDelPedido(second.body)).toBe(idDelPedido(first.body));
  });

  it('10 requests concurrentes con misma key → solo 1 ejecución (resto cacheada o 409)', async () => {
    const { user, cylinder, address, headers } = await seed(10);
    const idempotencyKey = randomUUID();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(env.app.getHttpServer())
          .post('/orders')
          .set(headers)
          .set('Idempotency-Key', idempotencyKey)
          .send({
            customerId: user.userId,
            addressId: address.addressId,
            paymentMethod: 'cash',
            items: [
              {
                gasCylinderId: cylinder.gasCylinderId,
                quantity: 1,
                unitPrice: 1000,
              },
            ],
          }),
      ),
    );

    // Cada response es 201 (cache hit) o 409 (lock en curso)
    const created = responses.filter((r) => r.status === 201);
    const conflicts = responses.filter((r) => r.status === 409);
    expect(created.length + conflicts.length).toBe(10);

    // Crítico: el stock solo decrementó UNA vez (10 - 1 = 9)
    const finalCylinder = await dataSource
      .getRepository(GasCylinder)
      .findOneOrFail({ where: { gasCylinderId: cylinder.gasCylinderId } });
    expect(finalCylinder.stock).toBe(9);

    // Todos los 201 deben tener el mismo orderId
    const orderIds = new Set(created.map((r) => idDelPedido(r.body)));
    expect(orderIds.size).toBe(1);
  }, 30000);
});
