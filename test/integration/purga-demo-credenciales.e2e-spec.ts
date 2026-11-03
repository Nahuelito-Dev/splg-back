/**
 * La purga de la demo y las credenciales de Mercado Pago: `payment.credential_id`
 * las referencia con ON DELETE RESTRICT, así que la purga normal (la del reseed)
 * las conserva —las cargó el admin— y sólo se van con la distribuidora entera,
 * después de los pagos. Corre con las FKs activas.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  purgarDistribuidoras,
  TRIGGERS_DE_SOLO_ESCRITURA,
} from '../../scripts/lib/purga-demo';
import { Admin } from '../../src/admin/entities/admin.entity';
import { RoleType } from '../../src/common/constants/role-type.enum';
import { Customer } from '../../src/customer/entities/customer.entity';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { GasCylinder } from '../../src/gascylinder/entities/gascylinder.entity';
import {
  PaymentGateway,
  PaymentIntegration,
} from '../../src/payments/domain/payment.enums';
import { Payment } from '../../src/payments/entities/payment.entity';
import { Role } from '../../src/role/entities/role.entity';
import { UserAddress } from '../../src/user-address/entities/user-address.entity';
import { User } from '../../src/users/entities/user.entity';
import {
  createTestApp,
  telefonoDePrueba,
  TestEnv,
  truncateAllTables,
} from './setup/test-env';

describe('Purga de la demo y credenciales de Mercado Pago (e2e)', () => {
  let env: TestEnv;
  let ds: DataSource;

  async function consultar<T>(sql: string, params: unknown[] = []) {
    const filas: unknown = await ds.query(sql, params);
    return filas as T[];
  }

  beforeAll(async () => {
    env = await createTestApp();
    ds = env.app.get(DataSource);
    // La purga apaga y prende los triggers de sólo escritura del esquema migrado;
    // el esquema de prueba no los trae todos, así que se crean los que falten (sin efecto).
    await ds.query(
      `CREATE FUNCTION purga_prueba_sin_efecto() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
    );
    for (const [tabla, trigger] of TRIGGERS_DE_SOLO_ESCRITURA) {
      const [{ existe }] = await consultar<{ existe: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = $1) AS existe`,
        [trigger],
      );
      if (!existe) {
        await ds.query(
          `CREATE TRIGGER "${trigger}" BEFORE TRUNCATE ON "${tabla}" FOR EACH STATEMENT EXECUTE FUNCTION purga_prueba_sin_efecto()`,
        );
      }
    }
  }, 120000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
  });

  async function rol(type: string): Promise<Role> {
    const roles = ds.getRepository(Role);
    return (
      (await roles.findOne({ where: { type } })) ??
      (await roles.save({ type } as Partial<Role>))
    );
  }

  async function usuario(tipo: RoleType, distributorId: string | null) {
    const s = randomUUID().slice(0, 8);
    const email = `${tipo}.${s}@splg.local`;
    const user = await ds.getRepository(User).save({
      email,
      fullName: `Test ${tipo} ${s}`,
      phoneNumber: telefonoDePrueba(),
      roleId: (await rol(tipo)).roleId,
    } as Partial<User>);
    if (tipo === RoleType.ADMIN) {
      await ds
        .getRepository(Admin)
        .save({ userId: user.userId, distributorId } as Partial<Admin>);
    } else {
      await ds
        .getRepository(Customer)
        .save({ userId: user.userId } as Partial<Customer>);
    }
    return {
      user,
      headers: {
        Authorization: `Bearer ${email}`,
        'X-Client-Source':
          tipo === RoleType.CUSTOMER ? 'customer-app' : 'panel-app',
      },
    };
  }

  /** Distribuidora con credencial, un pago que la usa y una conciliación con un ítem de ese pago. */
  async function escenario() {
    const s = randomUUID().slice(0, 8);
    const dist = await ds
      .getRepository(Distributor)
      .save({ name: `Dist ${s}`, slug: `dist-${s}` } as Partial<Distributor>);
    const admin = await usuario(RoleType.ADMIN, dist.distributorId);
    const cliente = await usuario(RoleType.CUSTOMER, null);
    const producto = await ds.getRepository(GasCylinder).save({
      type: '10kg',
      price: 1000,
      stock: 20,
      weight: 10,
      isActive: true,
      distributorId: dist.distributorId,
    } as Partial<GasCylinder>);
    const direccion = await ds.getRepository(UserAddress).save({
      userId: cliente.user.userId,
      street: 'Av. Test 123',
      city: 'CABA',
      latitude: '-34.6037',
      longitude: '-58.3816',
    } as Partial<UserAddress>);
    const res = await request(env.app.getHttpServer())
      .post('/orders')
      .set({ ...cliente.headers, 'X-Distributor': dist.slug })
      .send({
        customerId: cliente.user.userId,
        addressId: direccion.addressId,
        paymentMethod: 'cash',
        items: [
          {
            gasCylinderId: producto.gasCylinderId,
            quantity: 1,
            unitPrice: 1000,
          },
        ],
      })
      .expect(201);
    const orderId = (res.body as { order_id: string }).order_id;

    const [{ credential_id: credencialId }] = await consultar<{
      credential_id: string;
    }>(
      `INSERT INTO distributor_mercadopago_credentials
         (distributor_id, access_token_encrypted, public_key_encrypted, webhook_secret_encrypted, active, loaded_by_user_id, verified_at)
       VALUES ($1, 'x', 'y', 'z', true, $2, now()) RETURNING credential_id`,
      [dist.distributorId, admin.user.userId],
    );
    const pago = await ds.getRepository(Payment).save({
      orderId,
      distributorId: dist.distributorId,
      gateway: PaymentGateway.MERCADOPAGO,
      integration: PaymentIntegration.CHECKOUT_PRO,
      externalReference: orderId,
      amount: 1000,
    } as Partial<Payment>);
    await ds.query(
      `UPDATE payment SET credential_id = $2 WHERE payment_id = $1`,
      [pago.paymentId, credencialId],
    );
    const [{ reconciliation_id: conciliacionId }] = await consultar<{
      reconciliation_id: string;
    }>(
      `INSERT INTO mp_reconciliation (distributor_id, requested_by_user_id, from_date, to_date)
       VALUES ($1, $2, '2026-10-01', '2026-10-02') RETURNING reconciliation_id`,
      [dist.distributorId, admin.user.userId],
    );
    await ds.query(
      `INSERT INTO mp_reconciliation_item
         (reconciliation_id, distributor_id, row_key, kind, mp_description, note, payment_id, order_id)
       VALUES ($1, $2, $3, 'payment_not_in_cash', 'x', 'y', $4, $5)`,
      [
        conciliacionId,
        dist.distributorId,
        randomUUID(),
        pago.paymentId,
        orderId,
      ],
    );
    return { dist, credencialId };
  }

  const contar = async (tabla: string, distributorId: string) =>
    Number(
      (
        await consultar<{ n: string }>(
          `SELECT count(*) AS n FROM "${tabla}" WHERE "distributor_id" = $1`,
          [distributorId],
        )
      )[0].n,
    );

  it('la purga normal borra pagos y conciliaciones pero conserva la credencial, sin violar FKs', async () => {
    const { dist, credencialId } = await escenario();
    expect(await contar('payment', dist.distributorId)).toBe(1);

    await ds.transaction((m) =>
      purgarDistribuidoras(m, [dist.distributorId], { auditoriaGlobal: false }),
    );

    expect(await contar('payment', dist.distributorId)).toBe(0);
    expect(await contar('mp_reconciliation_item', dist.distributorId)).toBe(0);
    expect(await contar('mp_reconciliation', dist.distributorId)).toBe(0);
    expect(
      await contar('distributor_mercadopago_credentials', dist.distributorId),
    ).toBe(1);
    const filas = await consultar<{ credential_id: string }>(
      `SELECT credential_id FROM distributor_mercadopago_credentials WHERE distributor_id = $1`,
      [dist.distributorId],
    );
    expect(filas[0].credential_id).toBe(credencialId);
  }, 60000);

  it('la purga con borrado de la distribuidora se lleva también la credencial, después de los pagos', async () => {
    const { dist } = await escenario();

    await ds.transaction((m) =>
      purgarDistribuidoras(m, [dist.distributorId], {
        borrarDistribuidoras: true,
        auditoriaGlobal: false,
      }),
    );

    for (const tabla of [
      'payment',
      'mp_reconciliation_item',
      'mp_reconciliation',
      'distributor_mercadopago_credentials',
    ]) {
      expect({ tabla, n: await contar(tabla, dist.distributorId) }).toEqual({
        tabla,
        n: 0,
      });
    }
    const [{ n }] = await consultar<{ n: string }>(
      `SELECT count(*) AS n FROM distributor WHERE distributor_id = $1`,
      [dist.distributorId],
    );
    expect(Number(n)).toBe(0);
  }, 60000);
});
