/**
 * El cliente dado de alta desde el panel (POST /users) queda asociado a la
 * distribuidora que lo creó aunque no tenga pedidos: aparece en el listado, su
 * ficha abre, se lo puede dar de baja, y otra distribuidora no lo ve.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  TestEnv,
  createTestApp,
  telefonoDePrueba,
  truncateAllTables,
} from './setup/test-env';
import { FirebaseAuthPort } from '../../src/firebase/ports/firebase-auth.port';
import { Distributor } from '../../src/distributor/entities/distributor.entity';
import { Role } from '../../src/role/entities/role.entity';
import { User } from '../../src/users/entities/user.entity';
import { Admin } from '../../src/admin/entities/admin.entity';
import { CustomerDistributor } from '../../src/customer/entities/customer-distributor.entity';
import { CustomersService } from '../../src/customer/customer.service';

type Cuerpo = Record<string, unknown>;
type Headers = Record<string, string>;

describe('Alta de cliente desde el panel (e2e)', () => {
  let env: TestEnv;
  let dataSource: DataSource;

  beforeAll(async () => {
    env = await createTestApp();
    dataSource = env.app.get(DataSource);
    const firebase = env.app.get(FirebaseAuthPort);
    jest
      .spyOn(firebase, 'createUserSafe')
      .mockImplementation((datos) =>
        Promise.resolve({ uid: `uid-${datos.email}` } as never),
      );
    jest.spyOn(firebase, 'deleteUserSafe').mockResolvedValue();
  }, 120000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
    for (const tipo of ['admin', 'customer', 'super_admin']) await rol(tipo);
  });

  const http = () => request(env.app.getHttpServer());

  async function rol(type: string): Promise<Role> {
    const roles = dataSource.getRepository(Role);
    return (
      (await roles.findOne({ where: { type } })) ??
      (await roles.save({ type } as Partial<Role>))
    );
  }

  async function seedDistribuidora() {
    const sufijo = randomUUID().slice(0, 8);
    return (await dataSource.getRepository(Distributor).save({
      name: `Distribuidora ${sufijo}`,
      slug: `dist-${sufijo}`,
    } as Partial<Distributor>)) as Distributor;
  }

  async function seedAdmin(
    tipo: 'admin' | 'super_admin',
    distributorId: string | null,
  ) {
    const email = `${tipo}.${randomUUID().slice(0, 8)}@splg.local`;
    const user = (await dataSource.getRepository(User).save({
      email,
      fullName: 'Admin Test',
      phoneNumber: telefonoDePrueba(),
      roleId: (await rol(tipo)).roleId,
    } as Partial<User>)) as User;
    await dataSource
      .getRepository(Admin)
      .save({ userId: user.userId, distributorId } as Partial<Admin>);
    const headers: Headers = {
      Authorization: `Bearer ${email}`,
      'X-Client-Source': 'panel-app',
    };
    return { user, headers };
  }

  const altaDeCliente = (headers: Headers, over: Cuerpo = {}) =>
    http()
      .post('/users')
      .set(headers)
      .send({
        email: `cliente.${randomUUID().slice(0, 8)}@splg.local`,
        password: 'Test1234',
        full_name: 'Cliente Nuevo',
        phone_number: telefonoDePrueba(),
        rol: 'customer',
        ...over,
      });

  const cuerpoDe = <T = Cuerpo>(res: { body: unknown }) => res.body as T;

  it('lo ve en el listado y en la ficha, y lo puede dar de baja, sin pedidos', async () => {
    const d1 = await seedDistribuidora();
    const admin1 = await seedAdmin('admin', d1.distributorId);
    const superAdmin = await seedAdmin('super_admin', null);

    const alta = await altaDeCliente(admin1.headers).expect(201);
    const userId = cuerpoDe<{ user_id: string }>(alta).user_id;

    const listado = await http()
      .get('/customers')
      .set(admin1.headers)
      .expect(200);
    const clientes =
      cuerpoDe<Array<{ user_id: string; customer_id: string }>>(listado);
    expect(clientes.map((c) => c.user_id)).toEqual([userId]);
    expect(listado.headers['x-total-count']).toBe('1');
    const customerId = clientes[0].customer_id;

    await http()
      .get(`/customers/${customerId}`)
      .set(admin1.headers)
      .expect(200);

    // La baja de un cliente la hace el administrador general.
    await http()
      .delete(`/customers/${customerId}`)
      .set({ ...superAdmin.headers, 'X-Distributor': d1.slug })
      .expect(200);
    await http()
      .get('/customers')
      .set(admin1.headers)
      .expect(200)
      .expect((r) => expect(cuerpoDe<unknown[]>(r)).toHaveLength(0));
  }, 60000);

  it('otra distribuidora no lo ve ni llega a su ficha', async () => {
    const d1 = await seedDistribuidora();
    const d2 = await seedDistribuidora();
    const admin1 = await seedAdmin('admin', d1.distributorId);
    const admin2 = await seedAdmin('admin', d2.distributorId);

    const alta = await altaDeCliente(admin1.headers).expect(201);
    const userId = cuerpoDe<{ user_id: string }>(alta).user_id;
    const customerId = cuerpoDe<Array<{ customer_id: string }>>(
      await http().get('/customers').set(admin1.headers).expect(200),
    )[0].customer_id;

    await http()
      .get('/customers')
      .set(admin2.headers)
      .expect(200)
      .expect((r) => expect(cuerpoDe<unknown[]>(r)).toHaveLength(0));
    await http()
      .get(`/customers/${customerId}`)
      .set(admin2.headers)
      .expect(404);
    await http()
      .get(`/users/${userId}`)
      .set(admin2.headers)
      .expect((r) => expect(r.status).toBeGreaterThanOrEqual(403));
  }, 60000);

  it('un super admin con X-Distributor lo vincula con esa distribuidora', async () => {
    const d1 = await seedDistribuidora();
    const d2 = await seedDistribuidora();
    const admin2 = await seedAdmin('admin', d2.distributorId);
    const superAdmin = await seedAdmin('super_admin', null);

    const alta = await altaDeCliente({
      ...superAdmin.headers,
      'X-Distributor': d1.slug,
    }).expect(201);
    const userId = cuerpoDe<{ user_id: string }>(alta).user_id;

    const vinculos = await dataSource
      .getRepository(CustomerDistributor)
      .find({ where: { userId } });
    expect(vinculos.map((v) => v.distributorId)).toEqual([d1.distributorId]);
    await http()
      .get('/customers')
      .set(admin2.headers)
      .expect(200)
      .expect((r) => expect(cuerpoDe<unknown[]>(r)).toHaveLength(0));
  }, 60000);

  it('el vínculo es idempotente y la base impide duplicarlo', async () => {
    const d1 = await seedDistribuidora();
    const admin1 = await seedAdmin('admin', d1.distributorId);
    const alta = await altaDeCliente(admin1.headers).expect(201);
    const userId = cuerpoDe<{ user_id: string }>(alta).user_id;

    const customers = env.app.get(CustomersService);
    await dataSource.transaction((m) =>
      customers.vincularConDistribuidora(
        m,
        userId,
        d1.distributorId,
        admin1.user.userId,
      ),
    );
    const filas = await dataSource
      .getRepository(CustomerDistributor)
      .find({ where: { userId } });
    expect(filas).toHaveLength(1);
    expect(filas[0].createdByUserId).toBe(admin1.user.userId);

    await expect(
      dataSource.query(
        `INSERT INTO customer_distributor (user_id, distributor_id) VALUES ($1, $2)`,
        [userId, d1.distributorId],
      ),
    ).rejects.toThrow(/duplicate key|PK_customer_distributor/);
  }, 60000);

  it('si el alta falla, no queda ningún vínculo', async () => {
    const d1 = await seedDistribuidora();
    const admin1 = await seedAdmin('admin', d1.distributorId);
    const telefono = telefonoDePrueba();
    await altaDeCliente(admin1.headers, { phone_number: telefono }).expect(201);
    await altaDeCliente(admin1.headers, { phone_number: telefono }).expect(409);
    expect(await dataSource.getRepository(CustomerDistributor).count()).toBe(1);
  }, 60000);
});
