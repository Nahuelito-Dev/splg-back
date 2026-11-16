/**
 * Los procedimientos almacenados de las conciliaciones nocturnas contra un
 * Postgres de cero: detectan lo mismo que el cron, el COMMIT deja el borrado
 * de la alerta y el ROLLBACK (con RAISE) lo deshace.
 */
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { conBypass } from './setup/bypass';
import { ActorEnLaBase } from '../../src/audit/data/actor-en-la-base';
import { auditContext } from '../../src/audit/data/audit-context';

interface FilaStock {
  p_consistente: boolean;
  p_avisar: boolean;
  p_firma: string | null;
  p_resultado: {
    cylinders: Array<{
      gasCylinderId: string;
      sellable: number;
      expected: number;
      difference: number;
      overReserved: number;
      deficitDifference: number;
    }>;
    deliveriesWithoutMovement: Array<{
      orderId: string;
      gasCylinderId: string;
    }>;
  };
}

interface FilaCaja {
  p_desfasadas: number;
  p_detalle: Array<{ tipo: string; id: string; saldo: string; libro: string }>;
}

/** El algoritmo de la huella que tenía el cron en JS antes de pasar al procedimiento. */
function huellaDeAntes(r: {
  cylinders: Array<{
    gasCylinderId: string;
    difference: number;
    overReserved: number;
    deficitDifference?: number;
  }>;
  deliveriesWithoutMovement: Array<{ orderId: string; gasCylinderId: string }>;
}): string {
  const conProblema = (c: (typeof r.cylinders)[number]) =>
    c.difference !== 0 ||
    c.overReserved > 0 ||
    (c.deficitDifference ?? 0) !== 0;
  const partes = [
    ...r.cylinders
      .filter(conProblema)
      .map(
        (c) =>
          `c:${c.gasCylinderId}:${c.difference}:${c.overReserved}:${c.deficitDifference ?? 0}`,
      ),
    ...r.deliveriesWithoutMovement.map(
      (e) => `e:${e.orderId}:${e.gasCylinderId}`,
    ),
  ].sort();
  return createHash('sha256').update(partes.join('|')).digest('hex');
}

describe('Procedimientos de conciliación (e2e)', () => {
  let pg: StartedPostgreSqlContainer;
  let ds: DataSource;
  const dist = randomUUID();
  const otra = randomUUID();

  beforeAll(async () => {
    pg = await new PostgreSqlContainer(
      process.env.TEST_POSTGIS_IMAGE ?? 'postgis/postgis:14-3.4',
    )
      .withDatabase('splg_test')
      .withUsername('test')
      .withPassword('test')
      .start();
    ds = new DataSource({
      type: 'postgres',
      host: pg.getHost(),
      port: pg.getPort(),
      username: pg.getUsername(),
      password: pg.getPassword(),
      database: pg.getDatabase(),
      entities: [join(__dirname, '../../src/**/*.entity.ts')],
      migrations: [join(__dirname, '../../src/migrations/*.ts')],
      synchronize: false,
      migrationsTransactionMode: 'each',
    });
    await ds.initialize();
    await ds.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await ds.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await ds.runMigrations();
    await ds.query(
      `INSERT INTO "distributor" ("distributor_id", "name", "slug") VALUES ($1, 'A', 'a'), ($2, 'B', 'b')`,
      [dist, otra],
    );
  }, 240000);

  afterAll(async () => {
    await ds.destroy();
    await pg.stop();
  });

  const conciliarStock = async (id: string): Promise<FilaStock> => {
    const [fila] = await ds.query<FilaStock[]>(
      `CALL conciliar_stock_del_dia($1, NULL::boolean, NULL::boolean, NULL::text, NULL::jsonb)`,
      [id],
    );
    return fila;
  };
  const verificarCajas = async (id: string): Promise<FilaCaja> => {
    const [fila] = await ds.query<FilaCaja[]>(
      `CALL verificar_saldos_de_caja($1, NULL::integer, NULL::jsonb)`,
      [id],
    );
    return fila;
  };
  const alertas = async (id: string): Promise<number> =>
    Number(
      (
        await ds.query<Array<{ n: string }>>(
          `SELECT count(*) AS n FROM stock_reconciliation_alert WHERE distributor_id = $1`,
          [id],
        )
      )[0].n,
    );

  describe('conciliar_stock_del_dia', () => {
    let garrafa: string;

    beforeAll(async () => {
      garrafa = randomUUID();
      // Vendible 5 sin físico ni reservas: la diferencia es 5.
      await ds.query(
        `INSERT INTO gas_cylinder (gas_cylinder_id, distributor_id, type, weight, price, stock)
         VALUES ($1, $2, '10kg', 10, 100, 5)`,
        [garrafa, dist],
      );
    });

    it('detecta la diferencia y devuelve la huella sin escribir nada (la huella la guarda el cron)', async () => {
      const fila = await conciliarStock(dist);
      expect(fila.p_consistente).toBe(false);
      expect(fila.p_avisar).toBe(true);
      expect(fila.p_firma).toMatch(/^[0-9a-f]{64}$/);
      expect(fila.p_resultado.cylinders).toEqual([
        expect.objectContaining({
          gasCylinderId: garrafa,
          sellable: 5,
          expected: 0,
          difference: 5,
        }),
      ]);
      expect(await alertas(dist)).toBe(0);
    });

    it('la misma diferencia ya avisada no se vuelve a avisar', async () => {
      const { p_firma } = await conciliarStock(dist);
      await ds.query(
        `INSERT INTO stock_reconciliation_alert (distributor_id, signature) VALUES ($1, $2)`,
        [dist, p_firma],
      );
      expect((await conciliarStock(dist)).p_avisar).toBe(false);
      await ds.query(
        `UPDATE stock_reconciliation_alert SET signature = 'vieja' WHERE distributor_id = $1`,
        [dist],
      );
      expect((await conciliarStock(dist)).p_avisar).toBe(true);
    });

    it('COMMIT: si todo cierra borra la alerta y queda borrada', async () => {
      await ds.query(
        `UPDATE gas_cylinder SET stock = 0 WHERE gas_cylinder_id = $1`,
        [garrafa],
      );
      expect(await alertas(dist)).toBe(1);
      const fila = await conciliarStock(dist);
      expect(fila.p_consistente).toBe(true);
      expect(fila.p_avisar).toBe(false);
      expect(await alertas(dist)).toBe(0);
    });

    it('ROLLBACK: si la verificación posterior a la escritura falla, se deshace el borrado y se relanza el error', async () => {
      await ds.query(
        `INSERT INTO stock_reconciliation_alert (distributor_id, signature) VALUES ($1, 'x')`,
        [dist],
      );
      // El disparador repone la fila: la verificación posterior ve la alerta viva.
      await ds.query(
        `CREATE FUNCTION repone_alerta() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO stock_reconciliation_alert (distributor_id, signature) VALUES (OLD.distributor_id, 'repuesta'); RETURN NULL; END $$`,
      );
      await ds.query(
        `CREATE TRIGGER repone AFTER DELETE ON stock_reconciliation_alert FOR EACH ROW EXECUTE FUNCTION repone_alerta()`,
      );
      try {
        const error = await conciliarStock(dist).catch((e: unknown) => e);
        expect(error).toEqual(
          expect.objectContaining({
            message: expect.stringMatching(
              /conciliar_stock_del_dia falló: la alerta de .* sigue vigente/,
            ) as string,
            driverError: expect.objectContaining({ code: 'P0001' }) as unknown,
          }),
        );
        const [{ signature }] = await ds.query<Array<{ signature: string }>>(
          `SELECT signature FROM stock_reconciliation_alert WHERE distributor_id = $1`,
          [dist],
        );
        expect(signature).toBe('x');
      } finally {
        await ds.query(`DROP TRIGGER repone ON stock_reconciliation_alert`);
        await ds.query(`DROP FUNCTION repone_alerta()`);
        await ds.query(
          `DELETE FROM stock_reconciliation_alert WHERE distributor_id = $1`,
          [dist],
        );
      }
    });

    it('una distribuidora que no existe es un error, no un resultado vacío', async () => {
      await expect(conciliarStock(randomUUID())).rejects.toThrow(/no existe/);
    });

    it('no mira a otra distribuidora', async () => {
      await ds.query(
        `UPDATE gas_cylinder SET stock = 7 WHERE gas_cylinder_id = $1`,
        [garrafa],
      );
      const fila = await conciliarStock(otra);
      expect(fila.p_consistente).toBe(true);
      expect(fila.p_resultado.cylinders).toEqual([]);
    });
  });

  describe('verificar_saldos_de_caja', () => {
    let caja: string;

    beforeAll(async () => {
      caja = randomUUID();
      await conBypass(
        ds,
        ['saldos'],
        `INSERT INTO cash_box (cash_box_id, distributor_id, name, kind, balance) VALUES ($1, $2, 'Central', 'cash', 999)`,
        [caja, dist],
      );
    });

    it('COMMIT: informa la caja cuyo saldo no es la suma de su libro y no la corrige', async () => {
      const fila = await verificarCajas(dist);
      expect(fila.p_desfasadas).toBe(1);
      expect(fila.p_detalle).toEqual([
        { tipo: 'caja', id: caja, saldo: '999.00', libro: '0' },
      ]);
      const [{ balance }] = await ds.query<Array<{ balance: string }>>(
        `SELECT balance FROM cash_box WHERE cash_box_id = $1`,
        [caja],
      );
      expect(balance).toBe('999.00');
    });

    it('filtra por distribuidora', async () => {
      expect((await verificarCajas(otra)).p_desfasadas).toBe(0);
    });

    it('ROLLBACK: si falla una consulta adentro, RAISE', async () => {
      await ds.query(
        `ALTER TABLE customer_account_entry RENAME TO entry_renombrada`,
      );
      try {
        const error = await verificarCajas(dist).catch((e: unknown) => e);
        expect(error).toEqual(
          expect.objectContaining({
            message: expect.stringMatching(
              /verificar_saldos_de_caja falló: .*customer_account_entry/,
            ) as string,
            // undefined_table: el SQLSTATE original viaja en el relanzamiento.
            driverError: expect.objectContaining({ code: '42P01' }) as unknown,
          }),
        );
      } finally {
        await ds.query(
          `ALTER TABLE entry_renombrada RENAME TO customer_account_entry`,
        );
      }
      expect((await verificarCajas(dist)).p_desfasadas).toBe(1);
    });
  });

  describe('huella con varias diferencias', () => {
    const distF = randomUUID();
    const gA = randomUUID();
    const gB = randomUUID();
    const orden = randomUUID();

    beforeAll(async () => {
      const runner = ds.createQueryRunner();
      await runner.connect();
      try {
        // Fixture: sin FKs ni triggers (réplica) sólo para armar el estado.
        await runner.query(`SET session_replication_role = replica`);
        await runner.query(
          `INSERT INTO distributor (distributor_id, name, slug) VALUES ($1, 'F', 'f')`,
          [distF],
        );
        await runner.query(
          `INSERT INTO gas_cylinder (gas_cylinder_id, distributor_id, type, weight, price, stock, reservation_deficit) VALUES
           ($1, $3, 'A', 10, 100, 0, 0), ($2, $3, 'B', 15, 100, 2, 3)`,
          [gA, gB, distF],
        );
        const ubicacion = randomUUID();
        const deposito = randomUUID();
        await runner.query(
          `INSERT INTO warehouse (warehouse_id, distributor_id, name, code) VALUES ($1, $2, 'D', 'D1')`,
          [deposito, distF],
        );
        await runner.query(
          `INSERT INTO stock_location (location_id, distributor_id, kind, warehouse_id) VALUES ($1, $2, 'warehouse', $3)`,
          [ubicacion, distF, deposito],
        );
        // A: 4 llenas y vendible 0 → diferencia −4. B: vendible 2 sin físico → +2 y déficit 3.
        await runner.query(
          `INSERT INTO stock_balance (distributor_id, gas_cylinder_id, location_id, condition, quantity) VALUES ($1, $2, $3, 'full', 4)`,
          [distF, gA, ubicacion],
        );
        // Arranque del libro, y una entrega posterior sin movimiento.
        await runner.query(
          `INSERT INTO stock_movement (batch_id, distributor_id, gas_cylinder_id, quantity, to_location_id, to_condition, reason, reference_type, "createdAt")
           VALUES ($1, $2, $3, 4, $4, 'full', 'initial_count', 'initial', '2026-01-01')`,
          [randomUUID(), distF, gA, ubicacion],
        );
        await runner.query(
          `INSERT INTO "order" (order_id, distributor_id, customer_id, address_id, "paymentMethod", subtotal_items, "totalAmount", status, "acceptedAt", "onTheWayAt", "deliveredAt", delivery_id)
           VALUES ($1, $2, $3, $4, 'cash', 100, 100, 'delivered', '2026-02-01', '2026-02-01', '2026-02-01', $5)`,
          [orden, distF, randomUUID(), randomUUID(), randomUUID()],
        );
        await runner.query(
          `INSERT INTO order_item (order_id, gas_cylinder_id, quantity, "unitPrice", subtotal) VALUES ($1, $2, 1, 100, 100)`,
          [orden, gB],
        );
      } finally {
        await runner.query(`SET session_replication_role = DEFAULT`);
        await runner.release();
      }
    });

    it('es la misma que daba el algoritmo anterior en JS', async () => {
      const fila = await conciliarStock(distF);
      const { cylinders, deliveriesWithoutMovement } = fila.p_resultado;
      expect(cylinders.map((c) => c.difference).sort()).toEqual([-4, 2]);
      expect(cylinders.some((c) => c.deficitDifference === 3)).toBe(true);
      expect(deliveriesWithoutMovement).toEqual([
        expect.objectContaining({ orderId: orden, gasCylinderId: gB }),
      ]);
      expect(fila.p_firma).toBe(
        huellaDeAntes({ cylinders, deliveriesWithoutMovement }),
      );
    });
  });

  describe('desde un request (ActorEnLaBase)', () => {
    it('un CALL con el contexto de auditoría activo no se envuelve en una transacción', async () => {
      new ActorEnLaBase(ds);
      const fila = await auditContext.run(
        { userId: randomUUID(), ip: '10.0.0.1', distributorId: dist },
        () => verificarCajas(dist),
      );
      expect(fila.p_desfasadas).toBe(1);
    });
  });
});
