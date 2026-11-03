/**
 * Modelo de la hoja de ruta (M4, modalidad `planned`) en un Postgres real con
 * todas las migraciones: cada CHECK, único, clave foránea de tenant y el
 * trigger de transición de estado rechazan lo que tienen que rechazar y dejan
 * pasar lo válido. Cada caso inválido tiene su par válido, para que un CHECK
 * demasiado ancho o demasiado estrecho se note.
 */
import { readdirSync } from 'fs';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { purgarDistribuidoras } from '../../scripts/lib/purga-demo';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

describe('Hoja de ruta: reglas del modelo en la base (e2e)', () => {
  let pg: StartedPostgreSqlContainer;
  let ds: DataSource;

  const distA = randomUUID();
  const distB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const choferA = randomUUID();
  const choferA2 = randomUUID();
  const autoA = randomUUID();
  const autoA2 = randomUUID();
  const autoB = randomUUID();
  const depositoA = randomUUID();
  const depositoB = randomUUID();
  const FECHA = '2026-11-02';

  const insertarUsuario = async (id: string, email: string): Promise<void> => {
    await ds.query(`INSERT INTO "user" ("user_id", "email") VALUES ($1, $2)`, [
      id,
      email,
    ]);
  };

  /** La planificación del día, si todavía no existe (las hojas la necesitan). */
  const planificar = (distributorId: string, fecha: string) =>
    ds.query(
      `INSERT INTO route_plan (distributor_id, plan_date, cutoff_at) VALUES ($1, $2, now())
       ON CONFLICT (distributor_id, plan_date) DO NOTHING`,
      [distributorId, fecha],
    );

  /** Una hoja `planned` con los valores mínimos y lo que se pise en `extra`. */
  const hoja = async (
    extra: Record<string, unknown> = {},
    { conPlan = true } = {},
  ): Promise<string> => {
    const id = randomUUID();
    const distributorId =
      typeof extra.distributor_id === 'string' ? extra.distributor_id : distA;
    const base: Record<string, unknown> = {
      batch_id: id,
      distributor_id: distA,
      kind: 'planned',
      status: 'draft',
      total_weight_kg: 0,
      plan_date: FECHA,
      ...extra,
    };
    if (conPlan && typeof base.plan_date === 'string') {
      await planificar(distributorId, base.plan_date);
    }
    const columnas = Object.keys(base);
    await ds.query(
      `INSERT INTO "route_batch" (${columnas.map((c) => `"${c}"`).join(', ')})
       VALUES (${columnas.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(base),
    );
    return id;
  };

  const confirmada = (extra: Record<string, unknown> = {}) =>
    hoja({
      status: 'confirmed',
      delivery_id: choferA,
      car_id: autoA,
      confirmed_at: new Date(),
      ...extra,
    });

  const rechazaPor = (promesa: Promise<unknown>, restriccion: string) =>
    expect(promesa).rejects.toMatchObject({
      constraint: restriccion,
    });

  beforeAll(async () => {
    pg = await new PostgreSqlContainer(
      process.env.TEST_POSTGIS_IMAGE ?? 'postgis/postgis:14-3.4',
    )
      .withDatabase('splg_test')
      .withUsername('test')
      .withPassword('test')
      .start();
    const dir = resolve(__dirname, '../../src/migrations');
    ds = new DataSource({
      type: 'postgres',
      host: pg.getHost(),
      port: pg.getPort(),
      username: pg.getUsername(),
      password: pg.getPassword(),
      database: pg.getDatabase(),
      entities: [join(__dirname, '../../src/**/*.entity.ts')],
      migrations: readdirSync(dir)
        .filter((f) => f.endsWith('.ts'))
        .map((f) => join(dir, f)),
      synchronize: false,
      migrationsTransactionMode: 'each',
    });
    await ds.initialize();
    await ds.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await ds.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await ds.runMigrations();

    await ds.query(
      `INSERT INTO "distributor" ("distributor_id", "name", "slug") VALUES ($1, 'A', 'a'), ($2, 'B', 'b')`,
      [distA, distB],
    );
    await insertarUsuario(userA, 'a@x.com');
    await insertarUsuario(userB, 'b@x.com');
    const chofer2 = randomUUID();
    await insertarUsuario(chofer2, 'c2@x.com');
    await ds.query(
      `INSERT INTO delivery (delivery_id, distributor_id, user_id, validated, "isActive") VALUES ($1, $2, $3, true, true), ($4, $2, $5, true, true)`,
      [choferA, distA, userA, choferA2, chofer2],
    );
    await ds.query(
      `INSERT INTO car (car_id, distributor_id, user_id) VALUES ($1, $2, $3), ($4, $2, $3), ($5, $6, $7)`,
      [autoA, distA, userA, autoA2, autoB, distB, userB],
    );
    await ds.query(
      `INSERT INTO warehouse (warehouse_id, distributor_id, name, code) VALUES ($1, $2, 'Galpón', 'GAL'), ($3, $4, 'Galpón', 'GAL')`,
      [depositoA, distA, depositoB, distB],
    );
    await ds.query(
      `INSERT INTO route_plan (distributor_id, plan_date, status, cutoff_at) VALUES ($1, $2, 'open', now())`,
      [distA, FECHA],
    );
  }, 300000);

  afterAll(async () => {
    await ds?.destroy();
    await pg?.stop();
  });

  describe('lote de la modalidad oferta (lo de hoy)', () => {
    it('un lote sin modalidad es `offer`, sin fecha ni número, con versión 1', async () => {
      const [{ batch_id: id }] = await ds.query<Array<{ batch_id: string }>>(
        `INSERT INTO route_batch (distributor_id, total_weight_kg) VALUES ($1, 10) RETURNING batch_id`,
        [distA],
      );
      const [fila] = await ds.query<
        Array<{
          kind: string;
          status: string;
          plan_date: string | null;
          number: number | null;
          version: number;
        }>
      >(
        `SELECT kind, status, plan_date, number, version FROM route_batch WHERE batch_id = $1`,
        [id],
      );
      expect(fila).toEqual({
        kind: 'offer',
        status: 'forming',
        plan_date: null,
        number: null,
        version: 1,
      });
    });

    it('CHK_route_batch_hoja_fecha: un lote de oferta no lleva fecha de reparto', async () => {
      await rechazaPor(
        ds.query(
          `INSERT INTO route_batch (distributor_id, total_weight_kg, plan_date) VALUES ($1, 1, $2)`,
          [distA, FECHA],
        ),
        'CHK_route_batch_hoja_fecha',
      );
    });

    it('CHK_route_batch_estados_oferta: un lote de oferta no puede estar en borrador ni confirmado', async () => {
      for (const estado of ['draft', 'confirmed']) {
        await rechazaPor(
          ds.query(
            `INSERT INTO route_batch (distributor_id, total_weight_kg, status) VALUES ($1, 1, $2)`,
            [distA, estado],
          ),
          'CHK_route_batch_estados_oferta',
        );
      }
    });
  });

  describe('hoja planificada', () => {
    it('un borrador mínimo es válido', async () => {
      await expect(hoja()).resolves.toEqual(expect.any(String));
    });

    it('CHK_route_batch_hoja_fecha: una hoja sin fecha de reparto no existe', async () => {
      await rechazaPor(hoja({ plan_date: null }), 'CHK_route_batch_hoja_fecha');
    });

    it('CHK_route_batch_estados_hoja: una hoja no puede estar formándose ni ofrecida', async () => {
      for (const estado of ['forming', 'offered']) {
        await rechazaPor(
          hoja({ status: estado }),
          'CHK_route_batch_estados_hoja',
        );
      }
    });

    it('CHK_route_batch_hoja_confirmada: confirmada pide chofer, vehículo y fecha de confirmación', async () => {
      await expect(confirmada({ plan_date: '2026-11-10' })).resolves.toEqual(
        expect.any(String),
      );
      for (const faltante of ['delivery_id', 'car_id', 'confirmed_at']) {
        await rechazaPor(
          confirmada({ plan_date: '2026-11-11', [faltante]: null }),
          'CHK_route_batch_hoja_confirmada',
        );
      }
    });

    it('CHK_route_batch_hoja_confirmada: un borrador y una cancelada pueden no tener chofer', async () => {
      await expect(
        hoja({
          status: 'dissolved',
          closed_at: new Date(),
          close_reason: 'day_closed',
        }),
      ).resolves.toEqual(expect.any(String));
    });

    it('CHK_route_batch_hoja_iniciada: en curso pide la fecha de inicio', async () => {
      const en_curso = {
        status: 'assigned',
        delivery_id: choferA,
        car_id: autoA,
        confirmed_at: new Date(),
        plan_date: '2026-11-12',
      };
      await rechazaPor(hoja(en_curso), 'CHK_route_batch_hoja_iniciada');
      await expect(
        hoja({ ...en_curso, started_at: new Date() }),
      ).resolves.toEqual(expect.any(String));
    });

    it('CHK_route_batch_unidades, _pico, _totales y _hoja_numero', async () => {
      await rechazaPor(hoja({ total_units: -1 }), 'CHK_route_batch_unidades');
      await rechazaPor(hoja({ peak_units: -1 }), 'CHK_route_batch_pico');
      await rechazaPor(
        hoja({ total_distance_km: -0.5 }),
        'CHK_route_batch_totales',
      );
      await rechazaPor(
        hoja({ total_duration_min: -1 }),
        'CHK_route_batch_totales',
      );
      await rechazaPor(hoja({ number: 0 }), 'CHK_route_batch_hoja_numero');
      await rechazaPor(
        ds.query(
          `INSERT INTO route_batch (distributor_id, total_weight_kg, number) VALUES ($1, 1, 5)`,
          [distA],
        ),
        'CHK_route_batch_hoja_numero',
      );
      await expect(
        hoja({
          plan_date: '2026-11-13',
          total_units: 0,
          peak_units: 0,
          total_distance_km: 0,
          total_duration_min: 0,
        }),
      ).resolves.toEqual(expect.any(String));
    });

    it('método, origen de la matriz y quién propuso admiten sólo sus valores', async () => {
      await rechazaPor(
        hoja({ optimization_method: 'magia' }),
        'CHK_route_batch_metodo',
      );
      await rechazaPor(
        hoja({ matrix_source: 'bing' }),
        'CHK_route_batch_matriz',
      );
      await rechazaPor(
        hoja({ proposed_by: 'alguien' }),
        'CHK_route_batch_propuesta_por',
      );
      await expect(
        hoja({
          plan_date: '2026-11-14',
          optimization_method: 'nn_2opt',
          matrix_source: 'haversine',
          proposed_by: 'system',
        }),
      ).resolves.toEqual(expect.any(String));
    });
  });

  describe('planificación del día', () => {
    it('UQ_route_plan_dia: una sola por distribuidora y fecha; otra distribuidora sí puede', async () => {
      await rechazaPor(
        ds.query(
          `INSERT INTO route_plan (distributor_id, plan_date, cutoff_at) VALUES ($1, $2, now())`,
          [distA, FECHA],
        ),
        'UQ_route_plan_dia',
      );
      await expect(
        ds.query(
          `INSERT INTO route_plan (distributor_id, plan_date, cutoff_at) VALUES ($1, $2, now())`,
          [distB, FECHA],
        ),
      ).resolves.toBeDefined();
    });

    it('CHK_route_plan_propuesta y CHK_route_plan_cierre', async () => {
      await rechazaPor(
        ds.query(
          `INSERT INTO route_plan (distributor_id, plan_date, status, cutoff_at) VALUES ($1, '2026-12-01', 'proposed', now())`,
          [distA],
        ),
        'CHK_route_plan_propuesta',
      );
      await rechazaPor(
        ds.query(
          `INSERT INTO route_plan (distributor_id, plan_date, status, cutoff_at, proposed_at) VALUES ($1, '2026-12-01', 'closed', now(), now())`,
          [distA],
        ),
        'CHK_route_plan_cierre',
      );
      await rechazaPor(
        ds.query(
          `INSERT INTO route_plan (distributor_id, plan_date, status, cutoff_at, closed_at) VALUES ($1, '2026-12-01', 'open', now(), now())`,
          [distA],
        ),
        'CHK_route_plan_cierre',
      );
      await expect(
        ds.query(
          `INSERT INTO route_plan (distributor_id, plan_date, status, cutoff_at, proposed_at, closed_at) VALUES ($1, '2026-12-01', 'closed', now(), now(), now())`,
          [distA],
        ),
      ).resolves.toBeDefined();
    });

    it('un día armado a mano se cierra sin que haya corrido nunca la propuesta (open → closed)', async () => {
      const [{ plan_id: id }] = await ds.query<Array<{ plan_id: string }>>(
        `INSERT INTO route_plan (distributor_id, plan_date, cutoff_at) VALUES ($1, '2026-12-02', now()) RETURNING plan_id`,
        [distA],
      );
      await expect(
        ds.query(
          `UPDATE route_plan SET status = 'closed', closed_at = now() WHERE plan_id = $1`,
          [id],
        ),
      ).resolves.toBeDefined();
      const [fila] = await ds.query<
        Array<{ status: string; proposed_at: Date | null }>
      >(`SELECT status, proposed_at FROM route_plan WHERE plan_id = $1`, [id]);
      expect(fila).toEqual({ status: 'closed', proposed_at: null });
    });

    it('proposed sigue pidiendo la fecha de la propuesta, también al actualizar', async () => {
      const [{ plan_id: id }] = await ds.query<Array<{ plan_id: string }>>(
        `INSERT INTO route_plan (distributor_id, plan_date, cutoff_at) VALUES ($1, '2026-12-03', now()) RETURNING plan_id`,
        [distA],
      );
      await rechazaPor(
        ds.query(
          `UPDATE route_plan SET status = 'proposed' WHERE plan_id = $1`,
          [id],
        ),
        'CHK_route_plan_propuesta',
      );
    });

    it('FK_route_batch_plan_dia: la hoja necesita la planificación de su día y de su distribuidora', async () => {
      await rechazaPor(
        hoja({ plan_date: '2027-03-01' }, { conPlan: false }),
        'FK_route_batch_plan_dia',
      );
      // El día 2026-11-02 sólo está planificado para A.
      await rechazaPor(
        hoja(
          { distributor_id: distB, plan_date: '2026-11-03' },
          { conPlan: false },
        ),
        'FK_route_batch_plan_dia',
      );
      await expect(
        hoja({ distributor_id: distB, plan_date: FECHA }),
      ).resolves.toEqual(expect.any(String));
    });
  });

  describe('tenant cruzado', () => {
    it('el vehículo de otra distribuidora no entra en la hoja', async () => {
      await rechazaPor(
        hoja({ plan_date: '2026-11-04', car_id: autoB }),
        'FK_route_batch_car_distribuidora',
      );
    });

    it('el depósito de otra distribuidora no entra en la hoja', async () => {
      await rechazaPor(
        hoja({ plan_date: '2026-11-04', origin_warehouse_id: depositoB }),
        'FK_route_batch_origin_warehouse_distribuidora',
      );
      await expect(
        hoja({
          plan_date: '2026-11-04',
          origin_warehouse_id: depositoA,
          car_id: autoA,
        }),
      ).resolves.toEqual(expect.any(String));
    });
  });

  describe('un chofer y un vehículo, una hoja viva por día', () => {
    const DIA = '2026-11-20';

    it('UQ_route_batch_hoja_chofer_dia: la segunda confirmada del mismo chofer y día se rechaza', async () => {
      await confirmada({ plan_date: DIA, car_id: autoA });
      await rechazaPor(
        confirmada({ plan_date: DIA, car_id: autoA2 }),
        'UQ_route_batch_hoja_chofer_dia',
      );
    });

    it('UQ_route_batch_hoja_vehiculo_dia: la segunda confirmada del mismo vehículo y día se rechaza', async () => {
      await rechazaPor(
        confirmada({ plan_date: DIA, delivery_id: choferA2 }),
        'UQ_route_batch_hoja_vehiculo_dia',
      );
    });

    it('los borradores, las canceladas y otro día no cuentan', async () => {
      await expect(
        hoja({ plan_date: DIA, delivery_id: choferA, car_id: autoA }),
      ).resolves.toEqual(expect.any(String));
      await expect(
        hoja({
          plan_date: DIA,
          status: 'dissolved',
          closed_at: new Date(),
          close_reason: 'admin',
          delivery_id: choferA,
          car_id: autoA,
        }),
      ).resolves.toEqual(expect.any(String));
      await expect(
        confirmada({ plan_date: FECHA, delivery_id: choferA2, car_id: autoA2 }),
      ).resolves.toEqual(expect.any(String));
    });

    it('UQ_route_batch_numero: el número no se repite en la distribuidora, pero otra distribuidora puede usarlo', async () => {
      await hoja({ plan_date: DIA, number: 7 });
      await rechazaPor(
        hoja({ plan_date: DIA, number: 7 }),
        'UQ_route_batch_numero',
      );
      await expect(
        hoja({ plan_date: DIA, number: 7, distributor_id: distB }),
      ).resolves.toEqual(expect.any(String));
    });
  });

  describe('trigger de transición de estado', () => {
    const pasar = (id: string, estado: string) =>
      ds.query(`UPDATE route_batch SET status = $2 WHERE batch_id = $1`, [
        id,
        estado,
      ]);

    it('la hoja recorre borrador → confirmada → borrador → confirmada → en curso → cerrada', async () => {
      const id = await hoja({
        plan_date: '2026-11-21',
        delivery_id: choferA,
        car_id: autoA,
      });
      const camino: Array<[string, string]> = [
        ['confirmed', `confirmed_at = now()`],
        ['draft', `confirmed_at = now()`],
        ['confirmed', `confirmed_at = now()`],
        ['assigned', `started_at = now()`],
        ['completed', `closed_at = now()`],
      ];
      for (const [estado, extra] of camino) {
        await ds.query(
          `UPDATE route_batch SET status = $2, ${extra} WHERE batch_id = $1`,
          [id, estado],
        );
      }
      const [{ status }] = await ds.query<Array<{ status: string }>>(
        `SELECT status FROM route_batch WHERE batch_id = $1`,
        [id],
      );
      expect(status).toBe('completed');
    });

    it('un borrador no salta a en curso, y una hoja en curso no se cancela', async () => {
      const id = await hoja({
        plan_date: '2026-11-22',
        delivery_id: choferA,
        car_id: autoA,
      });
      await rechazaPor(
        pasar(id, 'assigned'),
        'CHK_route_batch_transicion_de_estado',
      );
      await ds.query(
        `UPDATE route_batch SET status = 'confirmed', confirmed_at = now() WHERE batch_id = $1`,
        [id],
      );
      await ds.query(
        `UPDATE route_batch SET status = 'assigned', started_at = now() WHERE batch_id = $1`,
        [id],
      );
      await rechazaPor(
        ds.query(
          `UPDATE route_batch SET status = 'dissolved', closed_at = now(), close_reason = 'admin' WHERE batch_id = $1`,
          [id],
        ),
        'CHK_route_batch_transicion_de_estado',
      );
    });

    it('un lote de oferta sigue su camino y no se salta pasos', async () => {
      const [{ batch_id: id }] = await ds.query<Array<{ batch_id: string }>>(
        `INSERT INTO route_batch (distributor_id, total_weight_kg) VALUES ($1, 10) RETURNING batch_id`,
        [distA],
      );
      await rechazaPor(
        pasar(id, 'assigned'),
        'CHK_route_batch_transicion_de_estado',
      );
      await pasar(id, 'offered');
      await pasar(id, 'offered');
      await ds.query(
        `UPDATE route_batch SET delivery_id = $2 WHERE batch_id = $1`,
        [id, choferA],
      );
      await pasar(id, 'assigned');
      await ds.query(
        `UPDATE route_batch SET status = 'completed', closed_at = now() WHERE batch_id = $1`,
        [id],
      );
      await rechazaPor(
        pasar(id, 'offered'),
        'CHK_route_batch_transicion_de_estado',
      );
    });

    it('la modalidad no se cambia: ni de oferta a hoja ni de hoja a oferta, tampoco con el bypass', async () => {
      const [{ batch_id: oferta }] = await ds.query<
        Array<{ batch_id: string }>
      >(
        `INSERT INTO route_batch (distributor_id, total_weight_kg) VALUES ($1, 10) RETURNING batch_id`,
        [distA],
      );
      await rechazaPor(
        ds.query(
          `UPDATE route_batch SET kind = 'planned', plan_date = $2 WHERE batch_id = $1`,
          [oferta, FECHA],
        ),
        'CHK_route_batch_transicion_de_estado',
      );
      const borrador = await hoja({ plan_date: '2026-11-23' });
      await rechazaPor(
        ds.query(
          `UPDATE route_batch SET kind = 'offer', plan_date = NULL, status = 'forming' WHERE batch_id = $1`,
          [borrador],
        ),
        'CHK_route_batch_transicion_de_estado',
      );
      await rechazaPor(
        ds.transaction(async (m) => {
          await m.query(`SET LOCAL splg.bypass_transiciones = 'on'`);
          await m.query(
            `UPDATE route_batch SET kind = 'offer', plan_date = NULL, status = 'forming' WHERE batch_id = $1`,
            [borrador],
          );
        }),
        'CHK_route_batch_transicion_de_estado',
      );
      const [{ kind }] = await ds.query<Array<{ kind: string }>>(
        `SELECT kind FROM route_batch WHERE batch_id = $1`,
        [borrador],
      );
      expect(kind).toBe('planned');
    });

    it('cada modalidad usa su tabla: una hoja no pasa a los estados del lote ofrecido', async () => {
      const id = await hoja({ plan_date: '2026-11-24' });
      await rechazaPor(
        pasar(id, 'offered'),
        'CHK_route_batch_transicion_de_estado',
      );
    });

    it('un lote disuelto o completado no se reabre', async () => {
      const [{ batch_id: id }] = await ds.query<Array<{ batch_id: string }>>(
        `INSERT INTO route_batch (distributor_id, total_weight_kg) VALUES ($1, 10) RETURNING batch_id`,
        [distA],
      );
      await ds.query(
        `UPDATE route_batch SET status = 'dissolved', closed_at = now(), close_reason = 'exhausted' WHERE batch_id = $1`,
        [id],
      );
      await rechazaPor(
        ds.query(
          `UPDATE route_batch SET status = 'forming', closed_at = NULL, close_reason = NULL WHERE batch_id = $1`,
          [id],
        ),
        'CHK_route_batch_transicion_de_estado',
      );
    });
  });

  describe('paradas', () => {
    let lote: string;
    const pedidos: string[] = [];

    const pedido = async (): Promise<string> => {
      const dir = randomUUID();
      await ds.query(
        `INSERT INTO user_address (address_id, user_id, street, city, "postalCode", "formattedAddress", location)
         VALUES ($1, $2, 'Calle 1', 'Posadas', '3300', 'Calle 1', ST_SetSRID(ST_MakePoint(-55.9, -27.36), 4326))`,
        [dir, userA],
      );
      const id = randomUUID();
      await ds.query(
        `INSERT INTO "order" (order_id, distributor_id, customer_id, address_id, status, "paymentMethod", "totalAmount", subtotal_items)
         VALUES ($1, $2, $3, $4, 'pending', 'cash', 100, 100)`,
        [id, distA, userA, dir],
      );
      pedidos.push(id);
      return id;
    };

    const parada = async (
      orderId: string,
      sequence: number,
      extra = '',
    ): Promise<unknown> =>
      await ds.query(
        `INSERT INTO route_batch_stop (batch_id, order_id, sequence${extra ? ', ' + extra.split('=')[0] : ''}) VALUES ($1, $2, $3${extra ? ', ' + extra.split('=')[1] : ''})`,
        [lote, orderId, sequence],
      );

    beforeAll(async () => {
      lote = await hoja({ plan_date: '2026-11-23' });
    });

    it('UQ_route_batch_stop_secuencia es parcial: una parada inactiva no bloquea el orden', async () => {
      const a = await pedido();
      const b = await pedido();
      const c = await pedido();
      await parada(a, 1);
      await ds.query(
        `UPDATE route_batch_stop SET active = false WHERE order_id = $1`,
        [a],
      );
      await parada(b, 1);
      await rechazaPor(parada(c, 1), 'UQ_route_batch_stop_secuencia');
      await expect(parada(c, 2)).resolves.toBeDefined();
    });

    it('una parada sale con su motivo y su fecha, y no al revés', async () => {
      const d = await pedido();
      await rechazaPor(
        parada(d, 3, `removed_reason='cancelled'`),
        'CHK_route_batch_stop_salida',
      );
      await rechazaPor(
        ds.query(
          `INSERT INTO route_batch_stop (batch_id, order_id, sequence, removed_at) VALUES ($1, $2, 3, now())`,
          [lote, d],
        ),
        'CHK_route_batch_stop_salida',
      );
      await ds.query(
        `INSERT INTO route_batch_stop (batch_id, order_id, sequence, active, removed_reason, removed_at) VALUES ($1, $2, 3, false, 'moved', now())`,
        [lote, d],
      );
    });

    it('la franja avisada tiene los dos extremos y termina después de empezar', async () => {
      const e = await pedido();
      await rechazaPor(
        ds.query(
          `INSERT INTO route_batch_stop (batch_id, order_id, sequence, notified_window_start) VALUES ($1, $2, 4, now())`,
          [lote, e],
        ),
        'CHK_route_batch_stop_ventana',
      );
      await rechazaPor(
        ds.query(
          `INSERT INTO route_batch_stop (batch_id, order_id, sequence, notified_window_start, notified_window_end) VALUES ($1, $2, 4, now(), now() - interval '1 hour')`,
          [lote, e],
        ),
        'CHK_route_batch_stop_ventana',
      );
      await ds.query(
        `INSERT INTO route_batch_stop (batch_id, order_id, sequence, notified_window_start, notified_window_end, leg_duration_min) VALUES ($1, $2, 4, now(), now() + interval '1 hour', 12.5)`,
        [lote, e],
      );
      await rechazaPor(
        ds.query(
          `UPDATE route_batch_stop SET leg_duration_min = -1 WHERE order_id = $1`,
          [e],
        ),
        'CHK_route_batch_stop_tramo_min',
      );
    });
  });

  describe('vehículo, parámetros y secuencia', () => {
    it('CHK_car_max_cylinders: las garrafas del vehículo son mayores que cero o desconocidas', async () => {
      await rechazaPor(
        ds.query(`UPDATE car SET max_cylinders = 0 WHERE car_id = $1`, [autoA]),
        'CHK_car_max_cylinders',
      );
      await ds.query(`UPDATE car SET max_cylinders = 40 WHERE car_id = $1`, [
        autoA,
      ]);
    });

    it('el depósito guarda su punto de salida', async () => {
      await ds.query(
        `UPDATE warehouse SET location = ST_SetSRID(ST_MakePoint(-55.9, -27.36), 4326) WHERE warehouse_id = $1`,
        [depositoA],
      );
      const [{ x }] = await ds.query<Array<{ x: number }>>(
        `SELECT ST_X(location) AS x FROM warehouse WHERE warehouse_id = $1`,
        [depositoA],
      );
      expect(x).toBeCloseTo(-55.9);
    });

    it('CHK_module_config_hoja_de_ruta: cada parámetro dentro de su rango', async () => {
      const guardar = (params: object) =>
        ds.query(
          `INSERT INTO module_config (distributor_id, module, params) VALUES ($1, 'route_planning', $2)
           ON CONFLICT (distributor_id, module) DO UPDATE SET params = EXCLUDED.params`,
          [distA, JSON.stringify(params)],
        );
      await expect(
        guardar({ enabled: 1, cutoffHour: 18, trafficFactor: 1.25 }),
      ).resolves.toBeDefined();
      for (const mal of [
        { cutoffHour: 24 },
        { cutoffMinute: 60 },
        { enabled: 2 },
        { maxStopsPerSheet: 1 },
        { trafficFactor: 3.5 },
        { cutoffHour: 18.5 },
        { etaWindowMinutes: '30' },
      ]) {
        await rechazaPor(guardar(mal), 'CHK_module_config_hoja_de_ruta');
      }
    });

    it('las otras distribuidoras y procesos no se ven afectados por el CHECK de la hoja', async () => {
      await expect(
        ds.query(
          `INSERT INTO module_config (distributor_id, module, params) VALUES ($1, 'route_batching', '{"enabled": 1}')`,
          [distB],
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('purga de la demo', () => {
    it('vacía la planificación, las hojas, el vehículo y el depósito de la distribuidora, en el orden de las claves', async () => {
      const distP = randomUUID();
      const userP = randomUUID();
      const autoP = randomUUID();
      const depositoP = randomUUID();
      await ds.query(
        `INSERT INTO "distributor" ("distributor_id", "name", "slug") VALUES ($1, 'P', 'purga-p')`,
        [distP],
      );
      await insertarUsuario(userP, 'purga@x.com');
      await ds.query(
        `INSERT INTO car (car_id, distributor_id, user_id) VALUES ($1, $2, $3)`,
        [autoP, distP, userP],
      );
      await ds.query(
        `INSERT INTO warehouse (warehouse_id, distributor_id, name, code) VALUES ($1, $2, 'Galpón', 'GAL')`,
        [depositoP, distP],
      );
      await hoja({
        distributor_id: distP,
        plan_date: '2026-11-30',
        car_id: autoP,
        origin_warehouse_id: depositoP,
      });
      await ds.transaction((m) =>
        purgarDistribuidoras(m, [distP], { borrarDistribuidoras: true }),
      );
      for (const [tabla, columna] of [
        ['route_batch', 'distributor_id'],
        ['route_plan', 'distributor_id'],
        ['car', 'distributor_id'],
        ['warehouse', 'distributor_id'],
        ['distributor', 'distributor_id'],
      ]) {
        const [{ n }] = await ds.query<Array<{ n: number }>>(
          `SELECT count(*)::int AS n FROM "${tabla}" WHERE "${columna}" = $1`,
          [distP],
        );
        expect([tabla, n]).toEqual([tabla, 0]);
      }
    });
  });
});
