/**
 * La migración `PedidosSinChoferVencen` contra un Postgres con el esquema de
 * antes: los pendientes que ya existen arrancan a contar desde que corre (no
 * desde su alta, así desplegar no cancela de golpe los viejos), el resto queda
 * en NULL, el CHECK del despacho valida la clave nueva y la reversa deja todo
 * como estaba.
 */
import { readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

describe('Migración PedidosSinChoferVencen (e2e)', () => {
  let pg: StartedPostgreSqlContainer;
  let ds: DataSource;

  const nuevo = (migraciones: string[]) =>
    new DataSource({
      type: 'postgres',
      host: pg.getHost(),
      port: pg.getPort(),
      username: pg.getUsername(),
      password: pg.getPassword(),
      database: pg.getDatabase(),
      migrations: migraciones,
      synchronize: false,
      migrationsTransactionMode: 'each',
    });

  const dir = join(__dirname, '../../src/migrations');
  const todas = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => join(dir, f));
  const indice = todas.findIndex((f) => /-PedidosSinChoferVencen\.ts$/.test(f));
  const anteriores = todas.slice(0, indice);
  const estaYAnteriores = todas.slice(0, indice + 1);

  const ids = {
    dist: randomUUID(),
    cliente: randomUUID(),
    direccion: randomUUID(),
    pendiente: randomUUID(),
    reserva: randomUUID(),
    cancelado: randomUUID(),
  };
  const VIEJO = new Date('2026-01-01T10:00:00Z');

  const ofrecibleDesde = async (orderId: string) => {
    const [fila] = await ds.query<Array<{ available_since: Date | null }>>(
      `SELECT available_since FROM "order" WHERE order_id = $1`,
      [orderId],
    );
    return fila.available_since;
  };
  const guardarDespacho = (params: object) =>
    ds
      .query(
        `INSERT INTO module_config (distributor_id, module, params) VALUES ($1, 'dispatch', $2::jsonb)
         ON CONFLICT (distributor_id, module) DO UPDATE SET params = EXCLUDED.params`,
        [ids.dist, JSON.stringify(params)],
      )
      .then(
        () => 'guardó',
        (err: Error) => err.message,
      );

  let antesDeMigrar: Date;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer(
      process.env.TEST_POSTGIS_IMAGE ?? 'postgis/postgis:14-3.4',
    )
      .withDatabase('splg_test')
      .withUsername('test')
      .withPassword('test')
      .start();

    ds = nuevo(anteriores);
    await ds.initialize();
    await ds.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await ds.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await ds.runMigrations();

    await ds.query(
      `INSERT INTO "distributor" ("distributor_id", "name", "slug") VALUES ($1, 'Dist', 'dist')`,
      [ids.dist],
    );
    await ds.query(
      `INSERT INTO "user" ("user_id", "email") VALUES ($1, 'cliente@x.com')`,
      [ids.cliente],
    );
    await ds.query(
      `INSERT INTO "user_address" ("address_id", "user_id", "street", "city") VALUES ($1, $2, 'Calle 1', 'CABA')`,
      [ids.direccion, ids.cliente],
    );
    for (const [orderId, status, motivo] of [
      [ids.pendiente, 'pending', null],
      [ids.reserva, 'reserved', null],
      [ids.cancelado, 'cancelled', 'Lo canceló el cliente'],
    ] as const) {
      await ds.query(
        `INSERT INTO "order" ("order_id", "distributor_id", "customer_id", "address_id", "status",
                              "paymentMethod", "paymentType", "totalAmount", "subtotal_items",
                              "cancellationReason", "createdAt")
         VALUES ($1, $2, $3, $4, $5, 'cash', 'cash', 1000, 1000, $6, $7)`,
        [orderId, ids.dist, ids.cliente, ids.direccion, status, motivo, VIEJO],
      );
    }
    await ds.destroy();

    antesDeMigrar = new Date();
    ds = nuevo(estaYAnteriores);
    await ds.initialize();
    await ds.runMigrations();
  }, 300000);

  afterAll(async () => {
    await ds?.destroy();
    await pg?.stop();
  });

  it('el pendiente que ya existía cuenta desde la migración, no desde su alta', async () => {
    const desde = await ofrecibleDesde(ids.pendiente);
    expect(desde).not.toBeNull();
    expect((desde as Date).getTime()).toBeGreaterThanOrEqual(
      antesDeMigrar.getTime() - 5_000,
    );
  });

  it('los que no están pendientes quedan en NULL', async () => {
    expect(await ofrecibleDesde(ids.reserva)).toBeNull();
    expect(await ofrecibleDesde(ids.cancelado)).toBeNull();
  });

  it('el CHECK del despacho valida los minutos sin chofer (1 a 1440, enteros)', async () => {
    expect(await guardarDespacho({ noDriverExpiryMinutes: 0 })).toContain(
      'CHK_module_config_despacho',
    );
    expect(await guardarDespacho({ noDriverExpiryMinutes: 12.5 })).toContain(
      'CHK_module_config_despacho',
    );
    expect(await guardarDespacho({ noDriverExpiryMinutes: 1440 })).toBe(
      'guardó',
    );
    // Lo de antes sigue validándose.
    expect(await guardarDespacho({ offerTtlSeconds: 9 })).toContain(
      'CHK_module_config_despacho',
    );
  });

  it('la reversa quita la columna y vuelve al CHECK anterior (la clave nueva se ignora)', async () => {
    await ds.undoLastMigration();
    const columnas = await ds.query<unknown[]>(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'order' AND column_name = 'available_since'`,
    );
    expect(columnas).toHaveLength(0);
    expect(await guardarDespacho({ noDriverExpiryMinutes: 0 })).toBe('guardó');
    expect(await guardarDespacho({ offerTtlSeconds: 9 })).toContain(
      'CHK_module_config_despacho',
    );
    // Y se puede volver a aplicar (con una configuración que el CHECK nuevo acepta).
    expect(await guardarDespacho({ noDriverExpiryMinutes: 30 })).toBe('guardó');
    await ds.runMigrations();
    expect(await ofrecibleDesde(ids.pendiente)).not.toBeNull();
  });
});
