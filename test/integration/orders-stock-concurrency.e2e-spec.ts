/**
 * Tests de integración: concurrencia de stock en CU-005 (Crear Pedido).
 *
 * Valida que el SELECT FOR UPDATE en OrderService.create() previene
 * oversell cuando múltiples clientes intentan comprar la última garrafa
 * simultáneamente.
 *
 * Escenario crítico:
 *   - GasCylinder con stock = 1
 *   - 10 clientes envían POST /orders al mismo tiempo
 *   - Solo 1 debe tener éxito; los demás deben recibir 400 "Stock insuficiente"
 *   - El stock final debe ser exactamente 0 (nunca negativo)
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

/** `res.body` de supertest llega sin tipar: se lee a través de esta forma
 * conocida en vez de acceder a un valor `any`. */
interface CuerpoError {
  message?: string;
}

function mensajeDeError(body: unknown): string {
  return (body as CuerpoError).message ?? '';
}

describe('CU-005 Orders Stock Concurrency (e2e)', () => {
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

  /**
   * Helper: crea las entidades mínimas requeridas para que el endpoint
   * POST /orders no falle por dependencias faltantes.
   *
   * Nota TS: TypeORM `save()` está sobrecargado y a veces TS infiere
   * el tipo unión `T | T[]`. Usamos casts a la entidad concreta para
   * mantener los tests legibles sin pelearnos con la inferencia.
   */
  async function seedMinimalScenario(stock: number) {
    const cylinderRepo = dataSource.getRepository(GasCylinder);
    const addressRepo = dataSource.getRepository(UserAddress);

    const { user, distributor, headers } = await sembrarClienteAutenticado(
      env.app,
    );

    const cylinder = (await cylinderRepo.save({
      type: '10kg',
      price: 1000,
      stock,
      weight: 10,
      isActive: true,
      distributorId: distributor.distributorId,
    } as Partial<GasCylinder>)) as GasCylinder;

    const address = (await addressRepo.save({
      userId: user.userId,
      street: 'Av. Test 123',
      city: 'CABA',
      latitude: '-34.6037',
      longitude: '-58.3816',
    } as Partial<UserAddress>)) as UserAddress;

    return { user, cylinder, address, headers };
  }

  it('previene oversell: 10 pedidos concurrentes con stock=1 → solo 1 éxito, stock final = 0', async () => {
    const { user, cylinder, address, headers } = await seedMinimalScenario(1);

    const orderPayload = {
      customerId: user.userId,
      addressId: address.addressId,
      paymentMethod: 'cash',
      items: [
        { gasCylinderId: cylinder.gasCylinderId, quantity: 1, unitPrice: 1000 },
      ],
    };

    // 10 requests concurrentes — Promise.all dispara todos antes de que el primero responda
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(env.app.getHttpServer())
          .post('/orders')
          .set(headers)
          .send(orderPayload),
      ),
    );

    const successes = responses.filter((r) => r.status === 201);
    const insufficientStock = responses.filter(
      (r) => r.status === 400 && /stock/i.test(mensajeDeError(r.body)),
    );

    expect(successes.length).toBe(1);
    expect(successes.length + insufficientStock.length).toBe(10);

    // Validación crítica: el stock en BD nunca queda negativo
    const finalCylinder = await dataSource
      .getRepository(GasCylinder)
      .findOneOrFail({ where: { gasCylinderId: cylinder.gasCylinderId } });
    expect(finalCylinder.stock).toBe(0);
  }, 30000);

  it('respeta stock parcial: 10 pedidos concurrentes con stock=3 → exactamente 3 éxitos', async () => {
    const { user, cylinder, address, headers } = await seedMinimalScenario(3);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(env.app.getHttpServer())
          .post('/orders')
          .set(headers)
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

    const successes = responses.filter((r) => r.status === 201);
    expect(successes.length).toBe(3);

    const finalCylinder = await dataSource
      .getRepository(GasCylinder)
      .findOneOrFail({ where: { gasCylinderId: cylinder.gasCylinderId } });
    expect(finalCylinder.stock).toBe(0);
  }, 30000);

  it('rollback completo si stock insuficiente: no decrementa parcialmente', async () => {
    const { user, cylinder, address, headers } = await seedMinimalScenario(2);

    // Pedido por 5 unidades — debe fallar y dejar stock intacto
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
            quantity: 5,
            unitPrice: 1000,
          },
        ],
      });

    expect(res.status).toBe(400);

    const finalCylinder = await dataSource
      .getRepository(GasCylinder)
      .findOneOrFail({ where: { gasCylinderId: cylinder.gasCylinderId } });
    // Stock intacto: el rollback funcionó
    expect(finalCylinder.stock).toBe(2);
  });
});
