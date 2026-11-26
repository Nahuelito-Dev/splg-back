/**
 * Retiro aprovechando la hoja de ruta (M5b) contra un Postgres/PostGIS de cero con
 * TODAS las migraciones: la distancia se mide en metros sobre `geography`, el radio
 * es un parámetro y nunca hay dos ofertas vivas para un mismo caso.
 *
 * Por omisión levanta un contenedor efímero. Con `M5_TEST_DB` (nombre de una base
 * vacía y migrada en el Postgres local de `DB_*`) la usa en lugar del contenedor;
 * en ese caso la base debe tener `session_replication_role = replica` para poder
 * sembrar sin armar choferes, vehículos ni envases.
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { DataSource } from 'typeorm';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { CylinderRecoveryCase } from '../../src/cylinder/entities/cylinder-recovery-case.entity';
import { CylinderRecoveryNotifier } from '../../src/cylinder/recovery/cylinder-recovery.notifier';
import { CylinderRecoveryPickupOpportunityService } from '../../src/cylinder/recovery/cylinder-recovery-pickup-opportunity.service';
import { CylinderRecoveryService } from '../../src/cylinder/recovery/cylinder-recovery.service';
import { parametrosDeRecupero } from '../../src/cylinder/recovery/domain/recovery-rules';
import { PARAMETROS } from '../../src/cylinder/recovery/recovery-test-kit';
import { AccesoDeLaEmpresa } from '../../src/platform/access/acceso-de-la-empresa.service';

/** Para sembrar puntos a una distancia conocida (metros al este del origen). */
const LON0 = -55.9;
const LAT0 = -27.36;
const GRADOS_POR_METRO = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
const aLongitud = (m: number): number => LON0 + m * GRADOS_POR_METRO;

describe('Retiro aprovechando la hoja (e2e)', () => {
  let pg: StartedPostgreSqlContainer | null = null;
  let ds: DataSource;
  const ahora = new Date();
  let porRadio = 300;
  const notifier = {
    porSocket: jest.fn(),
    alClienteAgrupado: jest.fn().mockResolvedValue(undefined),
  };
  let servicio: CylinderRecoveryPickupOpportunityService;

  beforeAll(async () => {
    const entities = [join(__dirname, '../../src/**/*.entity.ts')];
    const migrations = [join(__dirname, '../../src/migrations/*.ts')];
    if (process.env.M5_TEST_DB) {
      ds = new DataSource({
        type: 'postgres',
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT ?? 5432),
        username: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
        database: process.env.M5_TEST_DB,
        entities,
        synchronize: false,
      });
      await ds.initialize();
    } else {
      pg = await new PostgreSqlContainer(
        process.env.TEST_POSTGIS_IMAGE ?? 'postgis/postgis:14-3.4',
      )
        .withDatabase('splg_m5')
        .withUsername('test')
        .withPassword('test')
        .start();
      const opciones = {
        type: 'postgres' as const,
        host: pg.getHost(),
        port: pg.getPort(),
        username: pg.getUsername(),
        password: pg.getPassword(),
        database: pg.getDatabase(),
        entities,
        migrations,
        synchronize: false,
        migrationsTransactionMode: 'each' as const,
      };
      ds = new DataSource(opciones);
      await ds.initialize();
      await ds.query('CREATE EXTENSION IF NOT EXISTS postgis');
      await ds.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
      await ds.runMigrations();
      await ds.query(
        `ALTER DATABASE splg_m5 SET session_replication_role = replica`,
      );
      await ds.destroy();
      ds = new DataSource(opciones);
      await ds.initialize();
    }
    const engine = {
      parametros: () =>
        Promise.resolve({
          ...parametrosDeRecupero(PARAMETROS),
          enabled: true,
          opportunisticPickupRadiusMeters: porRadio,
        }),
    };
    servicio = new CylinderRecoveryPickupOpportunityService(
      ds.getRepository(CylinderRecoveryCase),
      engine as unknown as CylinderRecoveryService,
      notifier as unknown as CylinderRecoveryNotifier,
      {
        habilitado: () => Promise.resolve(true),
      } as unknown as AccesoDeLaEmpresa,
    );
  }, 300000);

  afterAll(async () => {
    await ds.destroy();
    if (pg) await pg.stop();
  });

  beforeEach(() => {
    porRadio = 300;
    notifier.porSocket.mockClear();
  });

  // ───────────────────────── datos ─────────────────────────

  interface Escenario {
    d: string;
    cliente: string;
    caso: string;
    hoja: string;
  }

  const usuario = async (): Promise<string> => {
    const u = randomUUID();
    await ds.query(
      `INSERT INTO "user" (user_id, email, full_name) VALUES ($1, $2, 'Cliente')`,
      [u, `${u}@t.local`],
    );
    return u;
  };
  const direccion = async (
    userId: string,
    metrosAlEste: number,
  ): Promise<string> => {
    const a = randomUUID();
    await ds.query(
      `INSERT INTO user_address (address_id, user_id, street, city, "postalCode", "formattedAddress", location)
       VALUES ($1, $2, 'Calle', 'Posadas', '3300', 'Calle', ST_SetSRID(ST_MakePoint($3, $4), 4326))`,
      [a, userId, aLongitud(metrosAlEste), LAT0],
    );
    return a;
  };

  /** Distribuidora con un cliente con un caso abierto (en el origen) y una hoja de hoy en curso. */
  const escenario = async (): Promise<Escenario> => {
    const d = randomUUID();
    await ds.query(
      `INSERT INTO distributor (distributor_id, name, slug) VALUES ($1, 'Dist', $2)`,
      [d, `d-${d.slice(0, 8)}`],
    );
    const cliente = await usuario();
    await direccion(cliente, 0);
    const caso = randomUUID();
    await ds.query(
      `INSERT INTO cylinder_recovery_case (case_id, distributor_id, cylinder_id, user_id, delivered_at, deposit_amount, status)
       VALUES ($1, $2, $3, $4, now(), 100, 'open')`,
      [caso, d, randomUUID(), cliente],
    );
    const hoja = randomUUID();
    await ds.query(
      `INSERT INTO route_batch (batch_id, distributor_id, status, kind, plan_date, number, total_weight_kg, delivery_id, car_id, confirmed_at, started_at)
       VALUES ($1, $2, 'assigned', 'planned', (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, $3, 10, $4, $5, now(), now())`,
      [
        hoja,
        d,
        Math.floor(Math.random() * 1_000_000) + 1,
        randomUUID(),
        randomUUID(),
      ],
    );
    return { d, cliente, caso, hoja };
  };

  /** Una parada de la hoja con el pedido de otro cliente a `metros` al este del caso. */
  const parada = async (
    e: Escenario,
    metros: number,
    opciones: {
      status?: string;
      llego?: boolean;
      activa?: boolean;
      clienteId?: string;
    } = {},
  ): Promise<string> => {
    const vecino = opciones.clienteId ?? (await usuario());
    const dir = await direccion(vecino, metros);
    const o = randomUUID();
    const status = opciones.status ?? 'accepted';
    await ds.query(
      `INSERT INTO "order" (order_id, distributor_id, customer_id, address_id, status, "paymentMethod", "totalAmount", subtotal_items, delivery_id, "acceptedAt", "onTheWayAt", "deliveryPoint")
       VALUES ($1, $2, $3, $4, $5, 'cash', 100, 100, $6, $7, $8, ST_SetSRID(ST_MakePoint($9, $10), 4326))`,
      [
        o,
        e.d,
        vecino,
        dir,
        status,
        status === 'pending' ? null : randomUUID(),
        status === 'pending' ? null : new Date(),
        status === 'on_the_way' ? new Date() : null,
        aLongitud(metros),
        LAT0,
      ],
    );
    const filas: Array<{ n: number }> = await ds.query(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM route_batch_stop WHERE batch_id = $1`,
      [e.hoja],
    );
    await ds.query(
      `INSERT INTO route_batch_stop (batch_id, order_id, sequence, active, arrived_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        e.hoja,
        o,
        filas[0].n,
        opciones.activa ?? true,
        opciones.llego ? new Date() : null,
      ],
    );
    return o;
  };

  interface AvisoFila {
    notice_id: string;
    order_id: string;
    route_batch_id: string;
    status: string;
    kind: string;
  }
  const avisos = async (caso: string): Promise<AvisoFila[]> => {
    const filas: AvisoFila[] = await ds.query(
      `SELECT notice_id, order_id, route_batch_id, status, kind FROM cylinder_recovery_notice WHERE case_id = $1 ORDER BY sent_at`,
      [caso],
    );
    return filas;
  };

  // ───────────────────────── distancia y radio ─────────────────────────

  describe('candidatos: la distancia se mide en metros', () => {
    it('un cliente a 250 m de una parada pendiente es candidato; a 350 m no', async () => {
      const cerca = await escenario();
      const pedidoCerca = await parada(cerca, 250);
      const lejos = await escenario();
      await parada(lejos, 350);

      const rc = await servicio.candidatos(cerca.d, null, 300, ahora);
      expect(rc).toHaveLength(1);
      expect(rc[0]).toEqual(
        expect.objectContaining({
          caseId: cerca.caso,
          orderId: pedidoCerca,
          batchId: cerca.hoja,
        }),
      );
      expect(rc[0].meters).toBeGreaterThan(245);
      expect(rc[0].meters).toBeLessThan(255);
      expect(await servicio.candidatos(lejos.d, null, 300, ahora)).toEqual([]);
    });

    it('el radio es un parámetro: con 400 m entra el de 350 m y con 200 m sale el de 250 m', async () => {
      const e = await escenario();
      await parada(e, 350);
      expect(await servicio.candidatos(e.d, null, 300, ahora)).toHaveLength(0);
      expect(await servicio.candidatos(e.d, null, 400, ahora)).toHaveLength(1);
      const f = await escenario();
      await parada(f, 250);
      expect(await servicio.candidatos(f.d, null, 200, ahora)).toHaveLength(0);
    });

    it('el borde: a 299 m entra y a 302 m no', async () => {
      const e = await escenario();
      await parada(e, 299);
      expect(await servicio.candidatos(e.d, null, 300, ahora)).toHaveLength(1);
      const f = await escenario();
      await parada(f, 302);
      expect(await servicio.candidatos(f.d, null, 300, ahora)).toHaveLength(0);
    });

    it('con varias paradas cerca elige la más cercana', async () => {
      const e = await escenario();
      await parada(e, 280);
      const mas = await parada(e, 90);
      await parada(e, 200);
      const [c] = await servicio.candidatos(e.d, null, 300, ahora);
      expect(c.orderId).toBe(mas);
    });

    it('no cuenta las paradas que ya no son pendientes ni los pedidos que no están en pie', async () => {
      const e = await escenario();
      await parada(e, 100, { llego: true });
      await parada(e, 100, { activa: false });
      await parada(e, 100, { status: 'pending' });
      expect(await servicio.candidatos(e.d, null, 300, ahora)).toEqual([]);
      await parada(e, 100, { status: 'on_the_way' });
      expect(await servicio.candidatos(e.d, null, 300, ahora)).toHaveLength(1);
    });

    it('no ofrece la parada del propio cliente, ni de una hoja de otro día o sin iniciar, ni de otra distribuidora', async () => {
      const e = await escenario();
      await parada(e, 50, { clienteId: e.cliente });
      expect(await servicio.candidatos(e.d, null, 300, ahora)).toEqual([]);

      const otroDia = await escenario();
      await parada(otroDia, 100);
      await ds.query(
        `UPDATE route_batch SET plan_date = plan_date + 1 WHERE batch_id = $1`,
        [otroDia.hoja],
      );
      expect(await servicio.candidatos(otroDia.d, null, 300, ahora)).toEqual(
        [],
      );

      const sinIniciar = await escenario();
      await parada(sinIniciar, 100);
      await ds.query(
        `UPDATE route_batch SET status = 'confirmed', started_at = NULL WHERE batch_id = $1`,
        [sinIniciar.hoja],
      );
      expect(await servicio.candidatos(sinIniciar.d, null, 300, ahora)).toEqual(
        [],
      );

      const a = await escenario();
      const b = await escenario();
      await parada(a, 100);
      expect(await servicio.candidatos(b.d, null, 300, ahora)).toEqual([]);
    });

    it('una dirección dada de baja no cuenta y cualquiera de las direcciones del cliente sirve', async () => {
      const e = await escenario();
      await ds.query(
        `UPDATE user_address SET "deletedAt" = now() WHERE user_id = $1`,
        [e.cliente],
      );
      await parada(e, 100);
      expect(await servicio.candidatos(e.d, null, 300, ahora)).toEqual([]);
      await direccion(e.cliente, 60);
      expect(await servicio.candidatos(e.d, null, 300, ahora)).toHaveLength(1);
    });

    it('sólo mira la hoja pedida cuando viene', async () => {
      const e = await escenario();
      await parada(e, 100);
      expect(await servicio.candidatos(e.d, e.hoja, 300, ahora)).toHaveLength(
        1,
      );
      expect(await servicio.candidatos(e.d, randomUUID(), 300, ahora)).toEqual(
        [],
      );
    });
  });

  // ───────────────────────── ofertas ─────────────────────────

  describe('ofrecer: nunca dos ofertas vivas', () => {
    it('crea la oferta ligada a la hoja y a la parada vecina; la segunda pasada no duplica', async () => {
      const e = await escenario();
      const pedido = await parada(e, 250);
      expect(await servicio.ofrecer(e.d, e.hoja, ahora)).toBe(1);
      expect(await servicio.ofrecer(e.d, e.hoja, ahora)).toBe(0);
      const rows = await avisos(e.caso);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.objectContaining({
          kind: 'pickup_offer',
          status: 'pending',
          order_id: pedido,
          route_batch_id: e.hoja,
        }),
      );
      expect(notifier.porSocket).toHaveBeenCalledTimes(1);
    });

    it('a 350 m no hay oferta; si el radio se amplía, sí', async () => {
      const e = await escenario();
      await parada(e, 350);
      expect(await servicio.ofrecer(e.d, null, ahora)).toBe(0);
      expect(await avisos(e.caso)).toHaveLength(0);
      porRadio = 400;
      expect(await servicio.ofrecer(e.d, null, ahora)).toBe(1);
    });

    it('tres pasadas a la vez dejan una sola oferta viva', async () => {
      const e = await escenario();
      await parada(e, 100);
      await Promise.all([
        servicio.ofrecer(e.d, null, ahora),
        servicio.ofrecer(e.d, null, ahora),
        servicio.ofrecer(e.d, null, ahora),
      ]);
      const vivas = (await avisos(e.caso)).filter(
        (a) => a.status === 'pending' || a.status === 'accepted',
      );
      expect(vivas).toHaveLength(1);
    });

    it('rechazada la oferta no se insiste con la misma parada, pero sí con otra', async () => {
      const e = await escenario();
      const primera = await parada(e, 100);
      await servicio.ofrecer(e.d, null, ahora);
      await ds.query(
        `UPDATE cylinder_recovery_notice SET status = 'rejected', responded_at = now() WHERE case_id = $1`,
        [e.caso],
      );
      expect(await servicio.ofrecer(e.d, null, ahora)).toBe(0);
      const segunda = await parada(e, 200);
      expect(await servicio.ofrecer(e.d, null, ahora)).toBe(1);
      const rows = await avisos(e.caso);
      expect(rows.map((r) => r.order_id)).toEqual([primera, segunda]);
    });

    it('una oferta común viva (entrega del propio cliente) también cuenta: no se suma otra', async () => {
      const e = await escenario();
      const propio = await parada(e, 10, { clienteId: e.cliente });
      await ds.query(
        `INSERT INTO cylinder_recovery_notice (notice_id, case_id, step, kind, status, order_id, expires_at)
         VALUES ($1, $2, 1, 'pickup_offer', 'pending', $3, now() + interval '1 day')`,
        [randomUUID(), e.caso, propio],
      );
      await parada(e, 100);
      expect(await servicio.ofrecer(e.d, null, ahora)).toBe(0);
      expect(await avisos(e.caso)).toHaveLength(1);
    });
  });
});
