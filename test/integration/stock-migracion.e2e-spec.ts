/**
 * La migración StockFisico contra un Postgres con datos: crea el "Depósito
 * central" de cada distribuidora existente, siembra el saldo inicial (vendible
 * + pedidos abiertos, D4), deja el libro de sólo escritura (trigger), no deja
 * diferencias con las entidades y se puede deshacer.
 */
import { readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

describe('Migración StockFisico (e2e)', () => {
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
      entities: [join(__dirname, '../../src/**/*.entity.ts')],
      migrations: migraciones,
      synchronize: false,
    });

  const dir = join(__dirname, '../../src/migrations');
  const todas = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => join(dir, f));
  // Las que van antes de StockFisico; las posteriores (conciliación, compras…)
  // dependen de sus tablas y corren con `todas`.
  const anteriores = todas.slice(
    0,
    todas.findIndex((f) => /StockFisico/.test(f)),
  );

  // Escenario: distribuidora A con dos productos y pedidos en todos los
  // estados; distribuidora B con un producto sin stock.
  const distA = randomUUID();
  const distB = randomUUID();
  const g10 = randomUUID();
  const g15 = randomUUID();
  const gB = randomUUID();

  async function pedido(
    distributorId: string,
    customerId: string,
    addressId: string,
    status: string,
    gasCylinderId: string,
    quantity: number,
  ) {
    const orderId = randomUUID();
    await ds.query(
      `INSERT INTO "order" ("order_id", "distributor_id", "customer_id", "address_id", "status",
                            "paymentMethod", "totalAmount", "subtotal_items")
       VALUES ($1, $2, $3, $4, $5, 'cash', 100, 100)`,
      [orderId, distributorId, customerId, addressId, status],
    );
    await ds.query(
      `INSERT INTO "order_item" ("order_id", "gas_cylinder_id", "quantity", "unitPrice", "subtotal")
       VALUES ($1, $2, $3, 10, 10)`,
      [orderId, gasCylinderId, quantity],
    );
  }

  beforeAll(async () => {
    pg = await new PostgreSqlContainer(
      process.env.TEST_POSTGIS_IMAGE ?? 'postgis/postgis:14-3.4',
    )
      .withDatabase('splg_test')
      .withUsername('test')
      .withPassword('test')
      .start();

    // Primero todo lo anterior, con datos; después, sólo la migración nueva.
    ds = nuevo(anteriores);
    await ds.initialize();
    await ds.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await ds.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await ds.runMigrations();

    const userId = randomUUID();
    const addressId = randomUUID();
    await ds.query(
      `INSERT INTO "distributor" ("distributor_id", "name", "slug") VALUES ($1, 'A', 'a'), ($2, 'B', 'b')`,
      [distA, distB],
    );
    await ds.query(
      `INSERT INTO "user" ("user_id", "email") VALUES ($1, 'c@x.com')`,
      [userId],
    );
    await ds.query(
      `INSERT INTO "user_address" ("address_id", "user_id", "street", "city") VALUES ($1, $2, 'x', 'y')`,
      [addressId, userId],
    );
    await ds.query(
      `INSERT INTO "gas_cylinder" ("gas_cylinder_id", "distributor_id", "type", "weight", "price", "stock")
       VALUES ($1, $4, '10kg', 10, 100, 40), ($2, $4, '15kg', 15, 150, 0), ($3, $5, '5kg', 5, 50, 0)`,
      [g10, g15, gB, distA, distB],
    );
    // 10kg: 6 reservados en pedidos abiertos (3 pending + 2 accepted + 1 on_the_way);
    // un entregado y un cancelado NO cuentan.
    await pedido(distA, userId, addressId, 'pending', g10, 3);
    await pedido(distA, userId, addressId, 'accepted', g10, 2);
    await pedido(distA, userId, addressId, 'on_the_way', g10, 1);
    await pedido(distA, userId, addressId, 'delivered', g10, 50);
    await pedido(distA, userId, addressId, 'cancelled', g10, 70);
    // 15kg: sin stock vendible pero 4 reservados en una reserva.
    await pedido(distA, userId, addressId, 'reserved', g15, 4);
    await ds.destroy();

    ds = nuevo(todas);
    await ds.initialize();
    await ds.runMigrations();
  }, 300000);

  afterAll(async () => {
    await ds?.destroy();
    await pg?.stop();
  });

  it('crea un "Depósito central" predeterminado en cada distribuidora existente', async () => {
    const filas = await ds.query<
      Array<{
        distributor_id: string;
        name: string;
        code: string;
        is_default: boolean;
      }>
    >(
      `SELECT distributor_id, name, code, is_default FROM warehouse ORDER BY name`,
    );
    expect(filas).toHaveLength(2);
    expect(filas.map((f) => f.distributor_id).sort()).toEqual(
      [distA, distB].sort(),
    );
    for (const f of filas) {
      expect(f).toMatchObject({
        name: 'Depósito central',
        code: 'CENTRAL',
        is_default: true,
      });
    }
    const ubicaciones = await ds.query<unknown[]>(
      `SELECT 1 FROM stock_location l JOIN warehouse w ON w.warehouse_id = l.warehouse_id WHERE l.kind = 'warehouse'`,
    );
    expect(ubicaciones).toHaveLength(2);
  });

  it('siembra llenas = vendible + pedidos abiertos (D4), sin contar entregados ni cancelados', async () => {
    const saldos = await ds.query<
      Array<{ type: string; condition: string; quantity: number }>
    >(
      `SELECT gc.type, b.condition, b.quantity
       FROM stock_balance b JOIN gas_cylinder gc ON gc.gas_cylinder_id = b.gas_cylinder_id
       ORDER BY gc.type`,
    );
    expect(saldos).toEqual([
      { type: '10kg', condition: 'full', quantity: 46 },
      { type: '15kg', condition: 'full', quantity: 4 },
    ]);
  });

  it('el invariante vale desde el arranque: vendible = llenas − abiertos', async () => {
    const [{ diferencias }] = await ds.query<Array<{ diferencias: string }>>(
      `SELECT COUNT(*) AS diferencias FROM gas_cylinder gc
       WHERE gc.stock <> COALESCE((SELECT SUM(quantity) FROM stock_balance b
                                   WHERE b.gas_cylinder_id = gc.gas_cylinder_id AND b.condition = 'full'), 0)
                         - COALESCE((SELECT SUM(oi.quantity) FROM order_item oi JOIN "order" o ON o.order_id = oi.order_id
                                     WHERE oi.gas_cylinder_id = gc.gas_cylinder_id
                                       AND o.status IN ('reserved','pending','accepted','on_the_way')), 0)`,
    );
    expect(Number(diferencias)).toBe(0);
  });

  it('deja un movimiento initial_count por saldo sembrado, agrupados por distribuidora, sin tocar el vendible', async () => {
    const movs = await ds.query<
      Array<{
        reason: string;
        reference_type: string;
        quantity: number;
        from_location_id: string | null;
        actor_user_id: string | null;
      }>
    >(
      `SELECT reason, reference_type, quantity, from_location_id, actor_user_id FROM stock_movement ORDER BY quantity`,
    );
    expect(movs).toEqual([
      {
        reason: 'initial_count',
        reference_type: 'initial',
        quantity: 4,
        from_location_id: null,
        actor_user_id: null,
      },
      {
        reason: 'initial_count',
        reference_type: 'initial',
        quantity: 46,
        from_location_id: null,
        actor_user_id: null,
      },
    ]);
    const stock = await ds.query<Array<{ type: string; stock: number }>>(
      `SELECT type, stock FROM gas_cylinder ORDER BY type`,
    );
    expect(stock).toEqual([
      { type: '10kg', stock: 40 },
      { type: '15kg', stock: 0 },
      { type: '5kg', stock: 0 },
    ]);
  });

  describe('el libro es de sólo escritura (trigger)', () => {
    it.each([
      ['UPDATE', `UPDATE stock_movement SET quantity = quantity + 1`],
      ['DELETE', `DELETE FROM stock_movement`],
      [
        'UPDATE de una sola fila',
        `UPDATE stock_movement SET notes = 'x' WHERE quantity = 4`,
      ],
    ])('%s falla', async (_n, sql) => {
      await expect(ds.query(sql)).rejects.toThrow(/sólo escritura/);
    });

    it('un asiento nuevo sí entra (append)', async () => {
      const [{ movement_id }] = await ds.query<Array<{ movement_id: string }>>(
        `SELECT movement_id FROM stock_movement LIMIT 1`,
      );
      const [{ to_location_id, gas_cylinder_id, distributor_id }] =
        await ds.query<
          Array<{
            to_location_id: string;
            gas_cylinder_id: string;
            distributor_id: string;
          }>
        >(
          `SELECT to_location_id, gas_cylinder_id, distributor_id FROM stock_movement WHERE movement_id = $1`,
          [movement_id],
        );
      await expect(
        ds.query(
          `INSERT INTO stock_movement (distributor_id, gas_cylinder_id, batch_id, quantity, from_location_id, from_condition, reason, reference_type)
           VALUES ($1, $2, $3, 1, $4, 'full', 'shrinkage', 'stock_adjustment')`,
          [distributor_id, gas_cylinder_id, randomUUID(), to_location_id],
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('restricciones de la base', () => {
    it('un saldo negativo es imposible (CHECK)', async () => {
      await expect(
        ds.query(`UPDATE stock_balance SET quantity = -1`),
      ).rejects.toThrow(/CHK_stock_balance_no_negativo/);
    });

    it('un movimiento con cantidad cero o sin origen ni destino es imposible', async () => {
      const [{ distributor_id, gas_cylinder_id, to_location_id }] =
        await ds.query<
          Array<{
            distributor_id: string;
            gas_cylinder_id: string;
            to_location_id: string;
          }>
        >(
          `SELECT distributor_id, gas_cylinder_id, to_location_id FROM stock_movement LIMIT 1`,
        );
      await expect(
        ds.query(
          `INSERT INTO stock_movement (distributor_id, gas_cylinder_id, batch_id, quantity, to_location_id, to_condition, reason, reference_type)
           VALUES ($1, $2, $3, 0, $4, 'full', 'adjustment', 'stock_adjustment')`,
          [distributor_id, gas_cylinder_id, randomUUID(), to_location_id],
        ),
      ).rejects.toThrow(/CHK_stock_movement_cantidad/);
      await expect(
        ds.query(
          `INSERT INTO stock_movement (distributor_id, gas_cylinder_id, batch_id, quantity, reason, reference_type)
           VALUES ($1, $2, $3, 1, 'adjustment', 'stock_adjustment')`,
          [distributor_id, gas_cylinder_id, randomUUID()],
        ),
      ).rejects.toThrow(/CHK_stock_movement_origen_o_destino/);
    });

    it('un pedido deja a lo sumo una entrega por garrafa (idempotencia en la base)', async () => {
      const [{ distributor_id, gas_cylinder_id, to_location_id }] =
        await ds.query<
          Array<{
            distributor_id: string;
            gas_cylinder_id: string;
            to_location_id: string;
          }>
        >(
          `SELECT distributor_id, gas_cylinder_id, to_location_id FROM stock_movement LIMIT 1`,
        );
      const orderId = randomUUID();
      const insertar = () =>
        ds.query(
          `INSERT INTO stock_movement (distributor_id, gas_cylinder_id, batch_id, quantity, from_location_id, from_condition, reason, reference_type, reference_id)
           VALUES ($1, $2, $3, 1, $4, 'full', 'delivery', 'order', $5)`,
          [
            distributor_id,
            gas_cylinder_id,
            randomUUID(),
            to_location_id,
            orderId,
          ],
        );
      await insertar();
      await expect(insertar()).rejects.toThrow(/UQ_stock_movement_pedido/);
    });

    it('un solo depósito predeterminado vigente por distribuidora', async () => {
      await expect(
        ds.query(
          `INSERT INTO warehouse (distributor_id, name, code, is_default) VALUES ($1, 'Otro', 'OTRO', true)`,
          [distA],
        ),
      ).rejects.toThrow(/UQ_warehouse_default_vigente/);
    });
  });

  it('las entidades y la migración no tienen diferencias (sin diff)', async () => {
    const sql = await ds.driver.createSchemaBuilder().log();
    expect(sql.upQueries.map((q) => q.query)).toEqual([]);
  });
});
