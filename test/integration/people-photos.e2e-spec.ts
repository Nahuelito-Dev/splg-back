/**
 * POST /api/v2/people/photos contra la base real: una distribuidora sólo recibe
 * las fotos de su gente. Lo de otra empresa, lo dado de baja y lo inexistente
 * salen `null` (200, sin revelar que existen). Versionado por URI como `main.ts`.
 */
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Finanzas, Headers, cuerpo } from './setup/finanzas';
import { TestEnv, createTestApp, truncateAllTables } from './setup/test-env';
import { randomUUID } from 'crypto';

interface Fotos {
  users: Record<string, { url: string; expiresAt: string } | null>;
  employees: Record<string, { url: string; expiresAt: string } | null>;
  deliveries: Record<string, { url: string; expiresAt: string } | null>;
}

describe('Fotos de personas por lote (e2e)', () => {
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

  const conFoto = async (userId: string) => {
    await ds.query(`UPDATE "user" SET photo_key = $2 WHERE user_id = $1`, [
      userId,
      `users/${userId}/foto.jpg`,
    ]);
  };

  const vincular = (
    userId: string,
    distributorId: string,
    baja = false,
  ): Promise<unknown> =>
    ds.query(
      `INSERT INTO customer_distributor (user_id, distributor_id, removed_at)
       VALUES ($1, $2, ${baja ? 'now()' : 'NULL'})`,
      [userId, distributorId],
    );

  const pedir = async (
    headers: Headers,
    body: {
      userIds?: string[];
      employeeIds?: string[];
      deliveryIds?: string[];
    },
  ) =>
    cuerpo<Fotos>(
      await request(env.app.getHttpServer())
        .post('/v2/people/photos')
        .set(headers)
        .send({ userIds: [], ...body })
        .expect(200),
    );

  it('cada empresa recibe sólo la foto de su gente', async () => {
    const a = await f.distribuidora();
    const b = await f.distribuidora();
    const compartido = await f.cliente('Compartido');
    const soloA = await f.cliente('Solo A');
    const soloB = await f.cliente('Solo B');
    const bajaEnA = await f.cliente('Baja en A');
    const choferB = await f.chofer(b.distributorId, 'Chofer B');
    const choferA = await f.chofer(a.distributorId, 'Chofer A');
    for (const id of [
      compartido.userId,
      soloA.userId,
      soloB.userId,
      bajaEnA.userId,
      choferA.userId,
      choferB.userId,
      b.adminUserId,
      a.adminUserId,
    ])
      await conFoto(id);
    await vincular(compartido.userId, a.distributorId);
    await vincular(compartido.userId, b.distributorId);
    await vincular(soloA.userId, a.distributorId);
    await vincular(soloB.userId, b.distributorId);
    await vincular(bajaEnA.userId, a.distributorId, true);

    const deA = await pedir(a.headers, {
      userIds: [
        compartido.userId,
        soloA.userId,
        soloB.userId,
        bajaEnA.userId,
        choferA.userId,
        choferB.userId,
        b.adminUserId,
        a.adminUserId,
        randomUUID(),
      ],
      employeeIds: [choferA.employeeId, choferB.employeeId],
      deliveryIds: [choferA.deliveryId, choferB.deliveryId],
    });
    const url = (id: string) => deA.users[id]?.url ?? null;
    expect(url(compartido.userId)).toContain(compartido.userId);
    expect(url(soloA.userId)).toContain(soloA.userId);
    expect(url(choferA.userId)).toContain(choferA.userId);
    expect(url(a.adminUserId)).toContain(a.adminUserId);
    expect(url(soloB.userId)).toBeNull();
    expect(url(bajaEnA.userId)).toBeNull();
    expect(url(choferB.userId)).toBeNull();
    expect(url(b.adminUserId)).toBeNull();
    expect(deA.employees[choferA.employeeId]?.url).toContain(choferA.userId);
    expect(deA.employees[choferB.employeeId]).toBeNull();
    expect(deA.deliveries[choferA.deliveryId]?.url).toContain(choferA.userId);
    expect(deA.deliveries[choferB.deliveryId]).toBeNull();

    const deB = await pedir(b.headers, {
      userIds: [compartido.userId, soloA.userId, soloB.userId],
      deliveryIds: [choferB.deliveryId, choferA.deliveryId],
    });
    expect(deB.users[compartido.userId]).not.toBeNull();
    expect(deB.users[soloB.userId]).not.toBeNull();
    expect(deB.users[soloA.userId]).toBeNull();
    expect(deB.deliveries[choferB.deliveryId]).not.toBeNull();
    expect(deB.deliveries[choferA.deliveryId]).toBeNull();
  });

  it('acepta ids en mayúsculas y responde indexado en minúsculas', async () => {
    const a = await f.distribuidora();
    const c = await f.cliente();
    await conFoto(c.userId);
    await vincular(c.userId, a.distributorId);
    const r = await pedir(a.headers, { userIds: [c.userId.toUpperCase()] });
    expect(r.users[c.userId]).not.toBeNull();
  });

  it('no deja asiento de auditoría de operaciones: es una lectura', async () => {
    const a = await f.distribuidora();
    await pedir(a.headers, { userIds: [randomUUID()] });
    // El asiento se guarda sin demorar la respuesta: se espera a que llegara.
    await new Promise((r) => setTimeout(r, 1000));
    const [{ n }] = await ds.query<Array<{ n: string }>>(
      `SELECT count(*) AS n FROM audit_log WHERE path LIKE '%people/photos%'`,
    );
    expect(Number(n)).toBe(0);
  });
});
