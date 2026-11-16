/**
 * La distribuidora da de baja a un cliente suyo (DELETE /customers/:id/distributor):
 * lo deja de ver ella, no su cuenta ni sus pedidos ni otras distribuidoras, y
 * un pedido nuevo lo reactiva. Con el versionado por URI activado, como `main.ts`
 * (las rutas nuevas son /api/v2/...; acá no hay prefijo global `api`).
 */
import request from 'supertest';
import { DataSource } from 'typeorm';
import { conIdempotencia } from './setup/con-idempotencia';
import { Finanzas, Headers, cuerpo } from './setup/finanzas';
import { TestEnv, createTestApp, truncateAllTables } from './setup/test-env';
import { Role } from '../../src/role/entities/role.entity';
import { User } from '../../src/users/entities/user.entity';
import { Admin } from '../../src/admin/entities/admin.entity';
import { randomUUID } from 'crypto';
import { forzarEstado } from './setup/bypass';
import { telefonoDePrueba } from './setup/test-env';
import { conSesionDeSoporte } from './matriz-http/soporte';

describe('Baja del cliente en la distribuidora (e2e)', () => {
  let env: TestEnv;
  let ds: DataSource;
  let f: Finanzas;

  beforeAll(async () => {
    env = await createTestApp();
    ds = env.app.get(DataSource);
    f = new Finanzas(env);
  }, 120000);

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await truncateAllTables(env.app);
  });

  const http = () => conIdempotencia(env.app.getHttpServer());

  type Entorno = Awaited<ReturnType<Finanzas['distribuidora']>>;
  type Cliente = Awaited<ReturnType<Finanzas['cliente']>>;

  async function superAdmin(): Promise<Headers> {
    const email = `super.${randomUUID().slice(0, 8)}@splg.local`;
    const roles = ds.getRepository(Role);
    const rol =
      (await roles.findOne({ where: { type: 'super_admin' } })) ??
      (await roles.save({ type: 'super_admin' } as Partial<Role>));
    const user = (await ds.getRepository(User).save({
      email,
      fullName: 'Super',
      phoneNumber: telefonoDePrueba(),
      roleId: rol.roleId,
    } as Partial<User>)) as User;
    await ds
      .getRepository(Admin)
      .save({ userId: user.userId, distributorId: null } as Partial<Admin>);
    return { Authorization: `Bearer ${email}`, 'X-Client-Source': 'panel-app' };
  }

  const listado = async (e: Entorno) =>
    cuerpo<Array<{ user_id: string; customer_id: string }>>(
      await request(env.app.getHttpServer())
        .get('/customers')
        .set(e.headers)
        .expect(200),
    );

  const customerIdDe = async (userId: string) =>
    (
      await ds.query<Array<{ customer_id: string }>>(
        `SELECT customer_id FROM customer WHERE user_id = $1`,
        [userId],
      )
    )[0].customer_id;

  const bajaEn = (e: Entorno, customerId: string, headers = e.headers) =>
    request(env.app.getHttpServer())
      .delete(`/v2/customers/${customerId}/distributor`)
      .set(headers);

  const pedir = (e: Entorno, c: Cliente) =>
    http()
      .post('/orders')
      .set(e.headers)
      .send({
        customerId: c.userId,
        addressId: c.addressId,
        paymentMethod: 'cash',
        items: [
          {
            gasCylinderId: e.garrafa.gasCylinderId,
            quantity: 1,
            unitPrice: 1000,
          },
        ],
      });

  const vinculo = (userId: string, distributorId: string) =>
    ds
      .query<
        Array<{ removed_at: Date | null; removed_by_user_id: string | null }>
      >(
        `SELECT removed_at, removed_by_user_id FROM customer_distributor
         WHERE user_id = $1 AND distributor_id = $2`,
        [userId, distributorId],
      )
      .then((r) => r[0]);

  it('el admin lo da de baja: deja de verlo, la otra empresa lo sigue viendo y nada se pierde', async () => {
    const d1 = await f.distribuidora();
    const d2 = await f.distribuidora();
    const c = await f.cliente();
    await f.pedidoEntregado(d1, { chofer: null, cliente: c });
    await f.pedidoEntregado(d2, { chofer: null, cliente: c });
    const customerId = await customerIdDe(c.userId);
    expect(await listado(d1)).toHaveLength(1);

    await bajaEn(d1, customerId).expect(200);

    expect(await listado(d1)).toHaveLength(0);
    await request(env.app.getHttpServer())
      .get(`/customers/${customerId}`)
      .set(d1.headers)
      .expect(404);
    expect(await listado(d2)).toHaveLength(1);
    const fila = await vinculo(c.userId, d1.distributorId);
    expect(fila.removed_at).not.toBeNull();
    expect(fila.removed_by_user_id).toBe(d1.adminUserId);
    // La cuenta y los pedidos históricos siguen.
    const [{ n }] = await ds.query<Array<{ n: string }>>(
      `SELECT count(*) AS n FROM "order" WHERE customer_id = $1`,
      [c.userId],
    );
    expect(Number(n)).toBe(2);
    const [{ vivo }] = await ds.query<Array<{ vivo: boolean }>>(
      `SELECT ("deletedAt" IS NULL) AS vivo FROM "user" WHERE user_id = $1`,
      [c.userId],
    );
    expect(vivo).toBe(true);
    // Repetir la baja ya es 404: el cliente dejó de ser suyo.
    await bajaEn(d1, customerId).expect(404);
  }, 60000);

  it('otra empresa no puede dar de baja a un cliente que no es suyo', async () => {
    const d1 = await f.distribuidora();
    const d2 = await f.distribuidora();
    const c = await f.cliente();
    await f.pedidoEntregado(d1, { chofer: null, cliente: c });
    const customerId = await customerIdDe(c.userId);

    await bajaEn(d2, customerId).expect(404);
    expect(await listado(d1)).toHaveLength(1);
  }, 60000);

  it('con un pedido en curso es 409 y el cliente sigue visible', async () => {
    const d1 = await f.distribuidora();
    const c = await f.cliente();
    await pedir(d1, c).expect(201);
    const customerId = await customerIdDe(c.userId);

    await bajaEn(d1, customerId).expect(409);
    expect(await listado(d1)).toHaveLength(1);
    expect(await vinculo(c.userId, d1.distributorId)).toBeUndefined();
  }, 60000);

  it('un pedido nuevo del cliente dado de baja lo reactiva', async () => {
    const d1 = await f.distribuidora();
    const c = await f.cliente();
    await f.pedidoEntregado(d1, { chofer: null, cliente: c });
    const customerId = await customerIdDe(c.userId);
    await bajaEn(d1, customerId).expect(200);
    expect(await listado(d1)).toHaveLength(0);

    await pedir(d1, c).expect(201);

    expect(await listado(d1)).toHaveLength(1);
    expect((await vinculo(c.userId, d1.distributorId)).removed_at).toBeNull();
  }, 60000);

  it('el super admin no la hace (sin sesión 403, en modo soporte sólo lectura); la baja global de la cuenta es de plataforma', async () => {
    const d1 = await f.distribuidora();
    const c = await f.cliente();
    await f.pedidoEntregado(d1, { chofer: null, cliente: c });
    const customerId = await customerIdDe(c.userId);
    const sa = await superAdmin();

    const soporte = await conSesionDeSoporte(env.app, d1.distributorId);
    const sinSesion = await bajaEn(d1, customerId, sa);
    const conXDistributor = await bajaEn(d1, customerId, {
      ...sa,
      'X-Distributor': d1.slug,
    });
    const enSoporte = await bajaEn(d1, customerId, soporte.cabeceras);
    expect([
      sinSesion.body,
      conXDistributor.body,
      enSoporte.body,
    ]).toMatchObject([
      { statusCode: 403, code: 'SUPPORT_SESSION_REQUIRED' },
      { statusCode: 403, code: 'SUPPORT_SESSION_REQUIRED' },
      { statusCode: 403, code: 'SUPPORT_READ_ONLY' },
    ]);
    expect(await listado(d1)).toHaveLength(1);

    // La baja de la cuenta (global) sigue siendo del super admin; al admin le da 403.
    const c2 = await f.cliente();
    await f.pedidoEntregado(d1, { chofer: null, cliente: c2 });
    const customerId2 = await customerIdDe(c2.userId);
    await request(env.app.getHttpServer())
      .delete(`/customers/${customerId2}`)
      .set(d1.headers)
      .expect(403);
    // Desde plataforma, la baja de la cuenta va por /users (identidad, D7).
    await request(env.app.getHttpServer())
      .delete(`/users/${c2.userId}`)
      .set(sa)
      .expect(200);
  }, 60000);

  it('la base no admite un autor de la baja sin fecha de baja', async () => {
    const d1 = await f.distribuidora();
    const c = await f.cliente();
    await expect(
      ds.query(
        `INSERT INTO customer_distributor (user_id, distributor_id, removed_by_user_id)
         VALUES ($1, $2, $3)`,
        [c.userId, d1.distributorId, d1.adminUserId],
      ),
    ).rejects.toThrow(/CHK_customer_distributor_baja/);
  }, 60000);

  it('una reserva (seña) también cuenta como pedido en curso: 409', async () => {
    const d1 = await f.distribuidora();
    const c = await f.cliente();
    const pedido = cuerpo<{ order_id: string }>(await pedir(d1, c).expect(201));
    await forzarEstado(
      ds,
      `UPDATE "order" SET status = 'reserved' WHERE order_id = $1`,
      [pedido.order_id],
    );
    await bajaEn(d1, await customerIdDe(c.userId)).expect(409);
  }, 60000);

  describe('clientes dados de baja y reactivación', () => {
    const removidos = (h: Headers, query = '') =>
      request(env.app.getHttpServer())
        .get(`/v2/customers/removed${query}`)
        .set(h);
    const reactivar = (h: Headers, customerId: string) =>
      request(env.app.getHttpServer())
        .post(`/v2/customers/${customerId}/distributor`)
        .set(h);

    it('lista sólo los dados de baja en MI distribuidora, busca por nombre o teléfono y no por correo', async () => {
      const d1 = await f.distribuidora();
      const d2 = await f.distribuidora();
      const ana = await f.cliente('Ana Removida');
      const beto = await f.cliente('Beto Vigente');
      for (const c of [ana, beto]) {
        await f.pedidoEntregado(d1, { chofer: null, cliente: c });
      }
      await f.pedidoEntregado(d2, { chofer: null, cliente: ana });
      await bajaEn(d1, await customerIdDe(ana.userId)).expect(200);

      const res = await removidos(d1.headers).expect(200);
      expect(
        cuerpo<Array<{ user_id: string }>>(res).map((x) => x.user_id),
      ).toEqual([ana.userId]);
      expect(res.headers['x-total-count']).toBe('1');
      await removidos(d1.headers, '?term=Removida')
        .expect(200)
        .expect((r) => expect(cuerpo<unknown[]>(r)).toHaveLength(1));
      await removidos(d1.headers, '?term=Nadie')
        .expect(200)
        .expect((r) => expect(cuerpo<unknown[]>(r)).toHaveLength(0));
      await removidos(d1.headers, '?term=@splg.local')
        .expect(200)
        .expect((r) => expect(cuerpo<unknown[]>(r)).toHaveLength(0));
      // La otra empresa no ve los removidos de la primera (ni a Ana, que sigue vigente en ella).
      await removidos(d2.headers)
        .expect(200)
        .expect((r) => expect(cuerpo<unknown[]>(r)).toHaveLength(0));
    }, 60000);

    it('el admin lo reactiva y vuelve a verlo; otra empresa no puede reactivarlo', async () => {
      const d1 = await f.distribuidora();
      const d2 = await f.distribuidora();
      const c = await f.cliente();
      await f.pedidoEntregado(d1, { chofer: null, cliente: c });
      await f.pedidoEntregado(d2, { chofer: null, cliente: c });
      const customerId = await customerIdDe(c.userId);
      await bajaEn(d1, customerId).expect(200);

      await reactivar(d2.headers, customerId).expect(404);
      expect(await listado(d1)).toHaveLength(0);

      await reactivar(d1.headers, customerId).expect(200);
      expect(await listado(d1)).toHaveLength(1);
      const fila = await vinculo(c.userId, d1.distributorId);
      expect(fila.removed_at).toBeNull();
      expect(fila.removed_by_user_id).toBeNull();
      // Ya vigente: reactivar de nuevo es 404.
      await reactivar(d1.headers, customerId).expect(404);
      await removidos(d1.headers)
        .expect(200)
        .expect((r) => expect(cuerpo<unknown[]>(r)).toHaveLength(0));
    }, 60000);

    it('el super admin no ve ni reactiva sin sesión de soporte, en soporte ve y no escribe; las rutas v2 no existen en v1', async () => {
      const d1 = await f.distribuidora();
      const c = await f.cliente();
      await f.pedidoEntregado(d1, { chofer: null, cliente: c });
      const customerId = await customerIdDe(c.userId);
      const sa = await superAdmin();
      await bajaEn(d1, customerId).expect(200);

      await removidos(sa).expect(403);
      await reactivar(sa, customerId).expect(403);
      const soporte = await conSesionDeSoporte(env.app, d1.distributorId);
      await removidos(soporte.cabeceras)
        .expect(200)
        .expect((r) => expect(cuerpo<unknown[]>(r)).toHaveLength(1));
      await reactivar(soporte.cabeceras, customerId).expect(403);
      await request(env.app.getHttpServer())
        .post(`/v1/customers/${customerId}/distributor`)
        .set(d1.headers)
        .expect(404);
    }, 60000);
  });
});
