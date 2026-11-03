/**
 * Las migraciones de la hoja de ruta contra una base con lotes de recorrido ya
 * cargados: los lotes y paradas de hoy sobreviven intactos como modalidad
 * `offer`, la secuencia pasa a ser parcial, y el camino de vuelta (`down`) deja
 * el esquema anterior sin perder las paradas y se puede volver a subir.
 */
import { readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

describe('Migración HojaDeRuta (e2e)', () => {
  let pg: StartedPostgreSqlContainer;
  let ds: DataSource;

  const dir = join(__dirname, '../../src/migrations');
  const todas = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => join(dir, f));
  const anteriores = todas.slice(
    0,
    todas.findIndex((f) => /HojaDeRutaEnums/.test(f)),
  );

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
      migrationsTransactionMode: 'each',
    });

  const distribuidora = randomUUID();
  const usuario = randomUUID();
  const loteViejo = randomUUID();
  const loteCerrado = randomUUID();
  const loteConHuecos = randomUUID();
  const pedidos = [randomUUID(), randomUUID(), randomUUID()];
  const pedidosConHuecos = [randomUUID(), randomUUID()];
  let triggerAntes = -1;

  const indice = async (nombre: string): Promise<string> => {
    const [fila] = await ds.query<Array<{ indexdef: string }>>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = $1`,
      [nombre],
    );
    return fila.indexdef;
  };
  const existe = async (tabla: string): Promise<boolean> => {
    const [{ r }] = await ds.query<Array<{ r: string | null }>>(
      `SELECT to_regclass($1)::text AS r`,
      [tabla],
    );
    return r !== null;
  };
  const columnas = async (tabla: string): Promise<string[]> =>
    (
      await ds.query<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [tabla],
      )
    ).map((c) => c.column_name);
  const trigger = async (): Promise<number> => {
    const [{ n }] = await ds.query<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'TRG_route_batch_transicion_de_estado'`,
    );
    return n;
  };

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
    triggerAntes = await trigger();
    await ds.query(
      `INSERT INTO "distributor" ("distributor_id", "name", "slug") VALUES ($1, 'A', 'a')`,
      [distribuidora],
    );
    await ds.query(
      `INSERT INTO "user" ("user_id", "email") VALUES ($1, 'u@x.com')`,
      [usuario],
    );
    const direccion = randomUUID();
    await ds.query(
      `INSERT INTO user_address (address_id, user_id, street, city, "postalCode", "formattedAddress", location)
       VALUES ($1, $2, 'Calle 1', 'Posadas', '3300', 'Calle 1', ST_SetSRID(ST_MakePoint(-55.9, -27.36), 4326))`,
      [direccion, usuario],
    );
    for (const p of [...pedidos, ...pedidosConHuecos]) {
      await ds.query(
        `INSERT INTO "order" (order_id, distributor_id, customer_id, address_id, status, "paymentMethod", "totalAmount", subtotal_items)
         VALUES ($1, $2, $3, $4, 'pending', 'cash', 100, 100)`,
        [p, distribuidora, usuario, direccion],
      );
    }
    await ds.query(
      `INSERT INTO route_batch (batch_id, distributor_id, status, total_weight_kg) VALUES ($1, $2, 'offered', 20)`,
      [loteViejo, distribuidora],
    );
    await ds.query(
      `INSERT INTO route_batch (batch_id, distributor_id, status, total_weight_kg, closed_at, close_reason)
       VALUES ($1, $2, 'dissolved', 10, now(), 'exhausted')`,
      [loteCerrado, distribuidora],
    );
    await ds.query(
      `INSERT INTO route_batch_stop (batch_id, order_id, sequence, leg_distance_km) VALUES ($1, $2, 1, 0), ($1, $3, 2, 1.5)`,
      [loteViejo, pedidos[0], pedidos[1]],
    );
    await ds.query(
      `INSERT INTO route_batch_stop (batch_id, order_id, sequence, active) VALUES ($1, $2, 1, false)`,
      [loteCerrado, pedidos[2]],
    );
    // Un lote sin secuencias repetidas pero con huecos: el `down` no lo toca.
    await ds.query(
      `INSERT INTO route_batch (batch_id, distributor_id, status, total_weight_kg, closed_at, close_reason)
       VALUES ($1, $2, 'dissolved', 5, now(), 'exhausted')`,
      [loteConHuecos, distribuidora],
    );
    await ds.query(
      `INSERT INTO route_batch_stop (batch_id, order_id, sequence, active) VALUES ($1, $2, 1, false), ($1, $3, 5, false)`,
      [loteConHuecos, pedidosConHuecos[0], pedidosConHuecos[1]],
    );
    await ds.destroy();

    ds = nuevo(todas);
    await ds.initialize();
    await ds.runMigrations();
  }, 300000);

  afterAll(async () => {
    await ds?.destroy();
    await pg?.stop();
  });

  it('los lotes de hoy quedan como oferta, sin fecha, número ni totales, con versión 1', async () => {
    const lotes = await ds.query<Array<Record<string, unknown>>>(
      `SELECT batch_id, kind, status, plan_date, number, car_id, total_units, version, total_weight_kg::float AS kg FROM route_batch ORDER BY total_weight_kg DESC`,
    );
    expect(lotes).toEqual([
      expect.objectContaining({
        batch_id: loteViejo,
        kind: 'offer',
        status: 'offered',
        plan_date: null,
        number: null,
        car_id: null,
        total_units: null,
        version: 1,
        kg: 20,
      }),
      expect.objectContaining({
        batch_id: loteCerrado,
        kind: 'offer',
        status: 'dissolved',
        version: 1,
        kg: 10,
      }),
      expect.objectContaining({ batch_id: loteConHuecos, kind: 'offer' }),
    ]);
  });

  it('las paradas de hoy conservan su orden, su tramo y quedan sin posición fija ni motivo de salida', async () => {
    const paradas = await ds.query<Array<Record<string, unknown>>>(
      `SELECT order_id, sequence, active, leg_distance_km::float AS km, sequence_locked, removed_reason, planned_eta_at
       FROM route_batch_stop WHERE batch_id = $1 ORDER BY sequence`,
      [loteViejo],
    );
    expect(paradas).toEqual([
      expect.objectContaining({
        order_id: pedidos[0],
        sequence: 1,
        active: true,
        km: 0,
        sequence_locked: false,
        removed_reason: null,
        planned_eta_at: null,
      }),
      expect.objectContaining({
        order_id: pedidos[1],
        sequence: 2,
        active: true,
        km: 1.5,
      }),
    ]);
  });

  it('antes de la migración no había trigger de transición en el lote: lo instala ella, una vez', () => {
    expect(triggerAntes).toBe(0);
  });

  it('la secuencia de las paradas es única sólo entre las vivas, y el trigger de transición está instalado una vez', async () => {
    expect(await indice('UQ_route_batch_stop_secuencia')).toMatch(
      /WHERE "?active"?\s*$|WHERE \(?"?active"?\)?/,
    );
    expect(await trigger()).toBe(1);
  });

  describe('camino de vuelta y nueva subida', () => {
    beforeAll(async () => {
      // Una parada inactiva que repite el orden de una viva: sólo cabe con el parcial.
      await ds.query(
        `INSERT INTO route_batch_stop (batch_id, order_id, sequence, active, removed_reason, removed_at)
         VALUES ($1, $2, 1, false, 'cancelled', now())`,
        [loteViejo, pedidos[2]],
      );
      await ds.query(
        `INSERT INTO route_plan (distributor_id, plan_date, cutoff_at) VALUES ($1, '2026-12-15', now())`,
        [distribuidora],
      );
      await ds.undoLastMigration(); // AuditoriaDeLaHojaDeRuta (sin efecto)
    });

    const intactoTrasRechazo = async () => {
      expect(await existe('route_plan')).toBe(true);
      expect(await columnas('route_batch')).toEqual(
        expect.arrayContaining(['kind']),
      );
      expect(await trigger()).toBe(1);
    };

    it('con una planificación cargada (sin hojas) el down se niega, con un mensaje claro, y no toca nada', async () => {
      await expect(ds.undoLastMigration()).rejects.toThrow(
        /No se puede revertir HojaDeRuta: hay 1 planificaciones de día/,
      );
      await intactoTrasRechazo();
    });

    it('con hojas de ruta cargadas el down se niega, con un mensaje claro, y no toca nada', async () => {
      await ds.query(
        `INSERT INTO route_batch (distributor_id, kind, status, plan_date, total_weight_kg) VALUES ($1, 'planned', 'draft', '2026-12-15', 0)`,
        [distribuidora],
      );
      await expect(ds.undoLastMigration()).rejects.toThrow(
        /No se puede revertir HojaDeRuta: hay 1 hojas de ruta/,
      );
      await intactoTrasRechazo();
    });

    it('sin hojas ni planificaciones el down sigue su camino', async () => {
      await ds.query(`DELETE FROM route_batch WHERE kind = 'planned'`);
      await ds.query(`DELETE FROM route_plan`);
      await ds.undoLastMigration(); // HojaDeRuta
      expect(await existe('route_plan')).toBe(false);
    });

    it('vuelve el esquema anterior: sin route_plan, sin columnas de la hoja, sin trigger', async () => {
      expect(await existe('route_plan')).toBe(false);
      expect(await columnas('route_batch')).not.toEqual(
        expect.arrayContaining(['kind']),
      );
      expect(await columnas('route_batch_stop')).not.toContain('removed_at');
      expect(await columnas('car')).not.toContain('max_cylinders');
      expect(await columnas('warehouse')).not.toContain('location');
      expect(await trigger()).toBe(0);
    });

    it('la secuencia vuelve a ser única en todas las paradas y no se perdió ninguna, con las vivas en su orden', async () => {
      expect(await indice('UQ_route_batch_stop_secuencia')).not.toMatch(
        /WHERE/,
      );
      const paradas = await ds.query<
        Array<{ order_id: string; sequence: number; active: boolean }>
      >(
        `SELECT order_id, sequence, active FROM route_batch_stop WHERE batch_id = $1 ORDER BY sequence`,
        [loteViejo],
      );
      expect(paradas).toEqual([
        { order_id: pedidos[0], sequence: 1, active: true },
        { order_id: pedidos[1], sequence: 2, active: true },
        { order_id: pedidos[2], sequence: 3, active: false },
      ]);
    });

    it('sólo se renumeran los lotes con secuencias repetidas: los demás conservan sus números', async () => {
      const huecos = await ds.query<Array<{ sequence: number }>>(
        `SELECT sequence FROM route_batch_stop WHERE batch_id = $1 ORDER BY sequence`,
        [loteConHuecos],
      );
      expect(huecos.map((p) => p.sequence)).toEqual([1, 5]);
      const cerrado = await ds.query<Array<{ sequence: number }>>(
        `SELECT sequence FROM route_batch_stop WHERE batch_id = $1`,
        [loteCerrado],
      );
      expect(cerrado.map((p) => p.sequence)).toEqual([1]);
    });

    it('se puede volver a subir y deja otra vez el modelo de la hoja', async () => {
      await ds.runMigrations();
      expect(await existe('route_plan')).toBe(true);
      expect(await columnas('route_batch')).toEqual(
        expect.arrayContaining(['kind', 'plan_date', 'version']),
      );
      expect(await indice('UQ_route_batch_stop_secuencia')).toMatch(/WHERE/);
      expect(await trigger()).toBe(1);
      const [{ n }] = await ds.query<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM route_batch WHERE kind = 'offer'`,
      );
      expect(n).toBe(3);
    });
  });
});
