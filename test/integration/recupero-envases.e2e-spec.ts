/* eslint-disable jest/expect-expect -- las aserciones están en el helper `rechaza` */
/**
 * Recuperación de envases no devueltos (CU-108, M5) contra un Postgres de cero
 * con TODAS las migraciones: las reglas de la base (único por envase vivo,
 * CHECK de estado y de oferta, rangos de los parámetros, la máquina de estados
 * del envase) y el ciclo completo del motor con un reloj controlado —detección
 * por SQL, escalones, escalamiento, decisión del administrador y devolución—.
 */
import { randomUUID } from 'crypto';
import { join } from 'path';
import { DataSource } from 'typeorm';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ActorEnLaBase } from '../../src/audit/data/actor-en-la-base';
import { CylinderService } from '../../src/cylinder/cylinder.service';
import { Cylinder } from '../../src/cylinder/entities/cylinder.entity';
import { CylinderMovement } from '../../src/cylinder/entities/cylinder-movement.entity';
import {
  CylinderRecoveryCase,
  RecoveryCaseStatus,
} from '../../src/cylinder/entities/cylinder-recovery-case.entity';
import {
  CylinderRecoveryNotice,
  RecoveryNoticeKind,
} from '../../src/cylinder/entities/cylinder-recovery-notice.entity';
import { CylinderRecoveryCasesService } from '../../src/cylinder/recovery/cylinder-recovery-cases.service';
import { CylinderRecoveryService } from '../../src/cylinder/recovery/cylinder-recovery.service';
import { RecoveryDecision } from '../../src/cylinder/recovery/dto/recovery-request.dto';
import { OrderLookupService } from '../../src/order/lookup/order-lookup.service';
import { Order } from '../../src/order/entities/order.entity';
import { diaArgentino } from '../../src/common/utils/dias-argentina';

const DIA = 24 * 60 * 60 * 1000;
// El reloj del motor se controla, pero la base sella `sent_at` con su `now()`: T0 tiene que ser el presente
// para que los vencimientos calculados desde T0 no queden en el pasado respecto de la base.
const T0 = new Date();

describe('Recupero de envases (e2e)', () => {
  let pg: StartedPostgreSqlContainer;
  let ds: DataSource;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer(
      process.env.TEST_POSTGIS_IMAGE ?? 'postgis/postgis:14-3.4',
    )
      .withDatabase('splg_recupero')
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
    // El mismo subscriber que fija el actor y la distribuidora en la app.
    new ActorEnLaBase(ds);
  }, 240000);

  afterAll(async () => {
    await ds.destroy();
    await pg.stop();
  });

  // ───────────────────────── datos ─────────────────────────

  const nuevaDistribuidora = async (): Promise<string> => {
    const d = randomUUID();
    await ds.query(
      `INSERT INTO distributor (distributor_id, name, slug) VALUES ($1, 'Dist', $2)`,
      [d, `d-${d.slice(0, 8)}`],
    );
    return d;
  };
  const nuevoUsuario = async (nombre = 'Ana Pérez'): Promise<string> => {
    const u = randomUUID();
    await ds.query(
      `INSERT INTO "user" (user_id, email, full_name) VALUES ($1, $2, $3)`,
      [u, `${u}@t.local`, nombre],
    );
    return u;
  };
  /** Un envase en poder de un cliente, entregado hace `dias` días respecto de T0. */
  const envaseAfuera = async (
    distributorId: string,
    clienteId: string,
    dias: number,
    deposito = 70000,
  ): Promise<string> => {
    const c = randomUUID();
    await ds.query(
      `INSERT INTO cylinder (cylinder_id, distributor_id, serial, state, current_customer_id, deposit)
       VALUES ($1, $2, $3, 'with_customer', $4, $5)`,
      [
        c,
        distributorId,
        `SN-${c.slice(0, 8)}`.toUpperCase(),
        clienteId,
        deposito,
      ],
    );
    await ds.query(
      `INSERT INTO cylinder_movement (cylinder_id, distributor_id, from_state, to_state, "createdAt")
       VALUES ($1, $2, 'dispatched', 'with_customer', $3)`,
      [c, distributorId, new Date(T0.getTime() - dias * DIA)],
    );
    return c;
  };
  const abrirCaso = (
    distributorId: string,
    cylinderId: string,
    userId: string,
    status = 'open',
  ) => {
    const id = randomUUID();
    const cerrado = !['open', 'escalated', 'lost'].includes(status);
    return ds
      .query(
        `INSERT INTO cylinder_recovery_case
           (case_id, distributor_id, cylinder_id, user_id, delivered_at, deposit_amount, status, closed_at, exhausted_at, resolution_note)
         VALUES ($1, $2, $3, $4, now(), 100, $5, $6, $7, $8)`,
        [
          id,
          distributorId,
          cylinderId,
          userId,
          status,
          cerrado ? new Date() : null,
          ['escalated', 'lost'].includes(status) ? new Date() : null,
          ['deposit_charged', 'written_off', 'closed_no_charge'].includes(
            status,
          )
            ? 'nota'
            : null,
        ],
      )
      .then(() => id);
  };
  const rechaza = async (sql: string, params: unknown[], regla: RegExp) => {
    await expect(ds.query(sql, params)).rejects.toThrow(regla);
  };

  // ───────────────────────── esquema y reglas de la base ─────────────────────────

  describe('esquema y reglas de la base', () => {
    it('las migraciones dejan las tablas del recupero sin diff contra las entidades', async () => {
      const sql = await ds.driver.createSchemaBuilder().log();
      const delRecupero = sql.upQueries
        .map((q) => q.query)
        .filter((q) => /recovery|module_config/.test(q));
      expect(delRecupero).toEqual([]);
    });

    it('un envase tiene a lo sumo un caso vivo; cerrado el anterior puede abrirse otro', async () => {
      const d = await nuevaDistribuidora();
      const u = await nuevoUsuario();
      const c = await envaseAfuera(d, u, 40);
      const primero = await abrirCaso(d, c, u);
      await rechaza(
        `INSERT INTO cylinder_recovery_case (distributor_id, cylinder_id, user_id, delivered_at, deposit_amount)
         VALUES ($1, $2, $3, now(), 1)`,
        [d, c, u],
        /UQ_recovery_case_envase_vivo/,
      );
      await ds.query(
        `UPDATE cylinder_recovery_case SET status = 'returned', closed_at = now() WHERE case_id = $1`,
        [primero],
      );
      await expect(abrirCaso(d, c, u)).resolves.toBeDefined();
    });

    it('un caso cerrado lleva fecha de cierre; uno vivo no; el agotado, su fecha', async () => {
      const d = await nuevaDistribuidora();
      const u = await nuevoUsuario();
      const c = await envaseAfuera(d, u, 40);
      const id = await abrirCaso(d, c, u);
      await rechaza(
        `UPDATE cylinder_recovery_case SET status = 'returned' WHERE case_id = $1`,
        [id],
        /CHK_recovery_case_estado/,
      );
      await rechaza(
        `UPDATE cylinder_recovery_case SET closed_at = now() WHERE case_id = $1`,
        [id],
        /CHK_recovery_case_estado/,
      );
      await rechaza(
        `UPDATE cylinder_recovery_case SET status = 'escalated' WHERE case_id = $1`,
        [id],
        /CHK_recovery_case_estado/,
      );
    });

    it('la decisión del administrador exige nota', async () => {
      const d = await nuevaDistribuidora();
      const u = await nuevoUsuario();
      const c = await envaseAfuera(d, u, 40);
      const id = await abrirCaso(d, c, u, 'escalated');
      await rechaza(
        `UPDATE cylinder_recovery_case SET status = 'deposit_charged', closed_at = now() WHERE case_id = $1`,
        [id],
        /CHK_recovery_case_estado/,
      );
      await rechaza(
        `UPDATE cylinder_recovery_case SET status = 'written_off', closed_at = now(), resolution_note = '  ' WHERE case_id = $1`,
        [id],
        /CHK_recovery_case_estado/,
      );
      await rechaza(
        `UPDATE cylinder_recovery_case SET status = 'written_off', closed_at = now(), resolution_note = 'corta' WHERE case_id = $1`,
        [id],
        /CHK_recovery_case_estado/,
      );
    });

    it('importe y escalón dentro de rango', async () => {
      const d = await nuevaDistribuidora();
      const u = await nuevoUsuario();
      const c = await envaseAfuera(d, u, 40);
      await rechaza(
        `INSERT INTO cylinder_recovery_case (distributor_id, cylinder_id, user_id, delivered_at, deposit_amount)
         VALUES ($1, $2, $3, now(), -1)`,
        [d, c, u],
        /CHK_recovery_case_importe_y_escalon/,
      );
      await rechaza(
        `INSERT INTO cylinder_recovery_case (distributor_id, cylinder_id, user_id, delivered_at, deposit_amount, step)
         VALUES ($1, $2, $3, now(), 1, 4)`,
        [d, c, u],
        /CHK_recovery_case_importe_y_escalon/,
      );
    });

    it('un aviso por escalón y una oferta por pedido; la oferta lleva pedido y estado', async () => {
      const d = await nuevaDistribuidora();
      const u = await nuevoUsuario();
      const c = await envaseAfuera(d, u, 40);
      const caso = await abrirCaso(d, c, u);
      const aviso = (step: number, kind: string) =>
        ds.query(
          `INSERT INTO cylinder_recovery_notice (case_id, step, kind, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')`,
          [caso, step, kind],
        );
      await aviso(1, 'reminder');
      await rechaza(
        `INSERT INTO cylinder_recovery_notice (case_id, step, kind, expires_at) VALUES ($1, 1, 'deposit_warning', now() + interval '1 day')`,
        [caso],
        /UQ_recovery_notice_aviso_por_escalon/,
      );
      await aviso(2, 'deposit_warning');
      await rechaza(
        `INSERT INTO cylinder_recovery_notice (case_id, step, kind, expires_at) VALUES ($1, 1, 'pickup_offer', now() + interval '1 day')`,
        [caso],
        /CHK_recovery_notice_oferta/,
      );
      await rechaza(
        `INSERT INTO cylinder_recovery_notice (case_id, step, kind, status, expires_at) VALUES ($1, 1, 'reminder', 'pending', now() + interval '1 day')`,
        [caso],
        /CHK_recovery_notice_oferta/,
      );
    });

    it('la oferta aceptada o rechazada lleva la fecha de respuesta', async () => {
      const d = await nuevaDistribuidora();
      const u = await nuevoUsuario();
      const c = await envaseAfuera(d, u, 40);
      const caso = await abrirCaso(d, c, u);
      const pedido = await pedidoDe(d, u);
      await rechaza(
        `INSERT INTO cylinder_recovery_notice (case_id, step, kind, status, order_id, expires_at)
         VALUES ($1, 1, 'pickup_offer', 'accepted', $2, now() + interval '1 day')`,
        [caso, pedido],
        /CHK_recovery_notice_oferta/,
      );
      await ds.query(
        `INSERT INTO cylinder_recovery_notice (case_id, step, kind, status, order_id, expires_at)
         VALUES ($1, 1, 'pickup_offer', 'pending', $2, now() + interval '1 day')`,
        [caso, pedido],
      );
      await rechaza(
        `INSERT INTO cylinder_recovery_notice (case_id, step, kind, status, order_id, expires_at)
         VALUES ($1, 1, 'pickup_offer', 'pending', $2, now() + interval '1 day')`,
        [caso, pedido],
        /UQ_recovery_notice_oferta_/,
      );
    });

    it('los parámetros del módulo se validan en la base', async () => {
      const d = await nuevaDistribuidora();
      const insertar = (params: object) =>
        ds.query(
          `INSERT INTO module_config (distributor_id, module, params) VALUES ($1, 'cylinder_recovery', $2::jsonb)`,
          [d, JSON.stringify(params)],
        );
      await rechaza(
        `INSERT INTO module_config (distributor_id, module, params) VALUES ($1, 'cylinder_recovery', $2::jsonb)`,
        [d, JSON.stringify({ toleranceDays: 0 })],
        /CHK_module_config_recuperacion/,
      );
      await rechaza(
        `INSERT INTO module_config (distributor_id, module, params) VALUES ($1, 'cylinder_recovery', $2::jsonb)`,
        [d, JSON.stringify({ runHour: 24 })],
        /CHK_module_config_recuperacion/,
      );
      await rechaza(
        `INSERT INTO module_config (distributor_id, module, params) VALUES ($1, 'cylinder_recovery', $2::jsonb)`,
        [d, JSON.stringify({ escalationStepDays: 1.5 })],
        /CHK_module_config_recuperacion/,
      );
      await rechaza(
        `INSERT INTO module_config (distributor_id, module, params) VALUES ($1, 'cylinder_recovery', $2::jsonb)`,
        [d, JSON.stringify({ enabled: 2 })],
        /CHK_module_config_recuperacion/,
      );
      await expect(
        insertar({
          toleranceDays: 45,
          escalationAmountThreshold: 1234.5,
          enabled: 1,
        }),
      ).resolves.toBeDefined();
    });

    it('el envase en poder de un cliente se puede dar por perdido; los demás saltos siguen prohibidos', async () => {
      const d = await nuevaDistribuidora();
      const u = await nuevoUsuario();
      const c = await envaseAfuera(d, u, 40);
      await rechaza(
        `UPDATE cylinder SET state = 'in_depot', current_customer_id = NULL WHERE cylinder_id = $1`,
        [c],
        /El envase no puede pasar de with_customer a in_depot/,
      );
      await ds.query(
        `UPDATE cylinder SET state = 'retired', current_customer_id = NULL WHERE cylinder_id = $1`,
        [c],
      );
    });
  });

  const pedidoDe = async (distributorId: string, userId: string) => {
    const dir = randomUUID();
    await ds.query(
      `INSERT INTO user_address (address_id, user_id, street, city, "postalCode", "formattedAddress", location)
       VALUES ($1, $2, 'Calle 1', 'Posadas', '3300', 'Calle 1', ST_SetSRID(ST_MakePoint(-55.9, -27.36), 4326))`,
      [dir, userId],
    );
    const pedido = randomUUID();
    await ds.query(
      `INSERT INTO "order" (order_id, distributor_id, customer_id, address_id, status, "paymentMethod", "totalAmount", subtotal_items)
       VALUES ($1, $2, $3, $4, 'pending', 'cash', 100, 100)`,
      [pedido, distributorId, userId, dir],
    );
    return pedido;
  };

  // ───────────────────────── el ciclo completo ─────────────────────────

  describe('ciclo del caso con reloj controlado', () => {
    let notificados: string[];
    let engine: CylinderRecoveryService;
    let cases: CylinderRecoveryCasesService;
    let umbral: number;

    const armar = (distributorId: string) => {
      notificados = [];
      umbral = 50000;
      const processConfig = {
        obtener: () =>
          Promise.resolve({
            toleranceDays: 30,
            escalationStepDays: 7,
            escalationAmountThreshold: umbral,
            pickupOfferTtlHours: 72,
            pickupWindowDays: 7,
            runHour: 4,
            enabled: 1,
          }),
        vigentes: jest.fn(),
        guardar: jest.fn(),
      };
      const orders = new OrderLookupService(ds.getRepository(Order));
      // «Cobrar envases» apagado: el recupero no se concilia con la cuenta (F35 E5).
      const apagado = {
        cubiertos: () => Promise.resolve(null),
        compraPorDeposito: () => Promise.resolve(false),
      };
      const notifier = {
        porSocket: (caso: CylinderRecoveryCase) => {
          notificados.push(`cliente:${caso.caseId}`);
        },
        alClienteAgrupado: () => Promise.resolve(),
        escaladoAlAdmin: (caso: CylinderRecoveryCase) => {
          notificados.push(`admin:${caso.caseId}`);
        },
      };
      engine = new CylinderRecoveryService(
        ds.getRepository(CylinderRecoveryCase),
        ds.getRepository(CylinderRecoveryNotice),
        processConfig as never,
        orders,
        notifier as never,
        apagado as never,
      );
      const cylinders = new CylinderService(
        ds.getRepository(Cylinder),
        ds.getRepository(CylinderMovement),
        orders,
        {} as never,
        new EventEmitter2(),
        {} as never,
        { descontarPropioDevuelto: () => Promise.resolve(false) } as never,
      );
      cases = new CylinderRecoveryCasesService(
        ds.getRepository(CylinderRecoveryCase),
        ds.getRepository(CylinderRecoveryNotice),
        engine,
        cylinders,
        orders,
        {} as never,
        processConfig as never,
        apagado as never,
      );
      return { distributorId };
    };

    const casoDe = (cylinderId: string) =>
      ds.getRepository(CylinderRecoveryCase).findOneByOrFail({ cylinderId });
    const avisosDe = (caseId: string) =>
      ds
        .getRepository(CylinderRecoveryNotice)
        .find({ where: { caseId }, order: { sentAt: 'ASC' } });
    const enDias = (n: number) => new Date(T0.getTime() + n * DIA);

    it('detecta, avisa por escalón, escala y el administrador cobra; la entrega ya resuelta no se reabre', async () => {
      const d = await nuevaDistribuidora();
      const u = await nuevoUsuario('Ana Pérez');
      armar(d);
      const viejo = await envaseAfuera(d, u, 40);
      const reciente = await envaseAfuera(d, u, 5);

      // Día 0: abre el caso del retenido y le manda el recordatorio.
      const r0 = await engine.ejecutar(d, T0);
      expect(r0).toEqual(
        expect.objectContaining({ abiertos: 1, avisos: 1, revisionManual: 0 }),
      );
      const caso = await casoDe(viejo);
      expect(caso.status).toBe(RecoveryCaseStatus.OPEN);
      expect(caso.step).toBe(1);
      expect(caso.depositAmount).toBe(70000);
      await expect(
        ds
          .getRepository(CylinderRecoveryCase)
          .findOneBy({ cylinderId: reciente }),
      ).resolves.toBeNull();

      // Dos corridas seguidas no duplican nada.
      const r0bis = await engine.ejecutar(d, T0);
      expect(r0bis).toEqual(
        expect.objectContaining({ abiertos: 0, avisos: 0 }),
      );
      expect(await avisosDe(caso.caseId)).toHaveLength(1);

      // Día 8: vence el primer escalón y sube al aviso del depósito.
      await engine.ejecutar(d, enDias(8));
      expect((await casoDe(viejo)).step).toBe(2);
      expect((await avisosDe(caso.caseId)).map((a) => a.kind)).toEqual([
        'reminder',
        'deposit_warning',
      ]);

      // Día 16: se agota; 70000 supera el umbral de 50000, escala.
      const r16 = await engine.ejecutar(d, enDias(16));
      expect(r16.escalados).toBe(1);
      const escalado = await casoDe(viejo);
      expect(escalado.status).toBe(RecoveryCaseStatus.ESCALATED);
      expect(escalado.exhaustedAt).not.toBeNull();
      expect(notificados.filter((n) => n.startsWith('admin:'))).toHaveLength(1);

      // Una corrida más no vuelve a tocar el caso escalado.
      await engine.ejecutar(d, enDias(30));
      expect((await casoDe(viejo)).status).toBe(RecoveryCaseStatus.ESCALATED);
      expect(await avisosDe(caso.caseId)).toHaveLength(2);

      // El administrador cobra el depósito: sólo se registra, el envase sigue afuera.
      const admin = await nuevoUsuario('Admin');
      const resuelto = await cases.resolver(
        caso.caseId,
        d,
        {
          decision: RecoveryDecision.CHARGE_DEPOSIT,
          note: 'Se cobra con el próximo pedido',
        },
        admin,
        enDias(31),
      );
      expect(resuelto.status).toBe(RecoveryCaseStatus.DEPOSIT_CHARGED);
      expect(resuelto.resolution).toEqual(
        expect.objectContaining({
          resolvedByUserId: admin,
          resolvedByName: 'Admin',
        }),
      );
      const envase = await ds
        .getRepository(Cylinder)
        .findOneByOrFail({ cylinderId: viejo });
      expect(envase.state).toBe('with_customer');

      // La misma entrega no reabre otro caso.
      const r = await engine.ejecutar(d, enDias(40));
      expect(r.abiertos).toBe(0);
      await expect(
        cases.resolver(
          caso.caseId,
          d,
          { decision: RecoveryDecision.CLOSE_NO_CHARGE, note: 'x' },
          admin,
        ),
      ).rejects.toThrow(/ya está cerrado/);
    });

    it('bajo el umbral queda como envase perdido y la baja del administrador lo saca del inventario', async () => {
      const d = await nuevaDistribuidora();
      const u = await nuevoUsuario();
      armar(d);
      const envase = await envaseAfuera(d, u, 40, 26000);
      await engine.ejecutar(d, T0);
      await engine.ejecutar(d, enDias(8));
      const r = await engine.ejecutar(d, enDias(16));
      expect(r.perdidos).toBe(1);
      const caso = await casoDe(envase);
      expect(caso.status).toBe(RecoveryCaseStatus.LOST);
      expect(notificados.filter((n) => n.startsWith('admin:'))).toEqual([]);

      const reporte = await cases.reporte(d, enDias(17));
      expect(reporte.totals).toEqual(
        expect.objectContaining({ lostCount: 1, lostAmount: 26000 }),
      );

      const admin = await nuevoUsuario('Admin');
      await cases.resolver(
        caso.caseId,
        d,
        {
          decision: RecoveryDecision.WRITE_OFF,
          note: 'Extraviado por el cliente',
        },
        admin,
        enDias(18),
      );
      const baja = await ds
        .getRepository(Cylinder)
        .findOneByOrFail({ cylinderId: envase });
      expect(baja.state).toBe('retired');
      expect(baja.currentCustomerId).toBeNull();
      const mov = await ds
        .getRepository(CylinderMovement)
        .findOneByOrFail({ cylinderId: envase, toState: 'retired' as never });
      expect(mov.note).toBe('Baja por pérdida: Extraviado por el cliente');
      expect(mov.actorUserId).toBe(admin);
    });

    it('si el envase vuelve en cualquier punto, el caso se cierra y los escalones pendientes no corren', async () => {
      const d = await nuevaDistribuidora();
      const u = await nuevoUsuario();
      armar(d);
      const envase = await envaseAfuera(d, u, 40);
      await engine.ejecutar(d, T0);
      const caso = await casoDe(envase);

      await ds.query(
        `UPDATE cylinder SET state = 'empty_returned', current_customer_id = NULL WHERE cylinder_id = $1`,
        [envase],
      );
      expect(await engine.cerrarPorDevolucion(d, envase, enDias(1))).toBe(true);
      expect((await casoDe(envase)).status).toBe(RecoveryCaseStatus.RETURNED);
      expect(await engine.cerrarPorDevolucion(d, envase)).toBe(false);

      const r = await engine.ejecutar(d, enDias(20));
      expect(r.avisos).toBe(0);
      expect(await avisosDe(caso.caseId)).toHaveLength(1);
    });

    it('la corrida detecta el retorno aunque el evento no haya llegado', async () => {
      const d = await nuevaDistribuidora();
      const u = await nuevoUsuario();
      armar(d);
      const envase = await envaseAfuera(d, u, 40);
      await engine.ejecutar(d, T0);
      await ds.query(
        `UPDATE cylinder SET state = 'empty_returned', current_customer_id = NULL WHERE cylinder_id = $1`,
        [envase],
      );
      const r = await engine.ejecutar(d, enDias(8));
      expect(r.cerradosPorDevolucion).toBe(1);
      expect((await casoDe(envase)).status).toBe(RecoveryCaseStatus.RETURNED);
    });

    it('ofrece el retiro en la entrega programada del cliente y espera mientras el pedido siga en pie', async () => {
      const d = await nuevaDistribuidora();
      const u = await nuevoUsuario();
      armar(d);
      const envase = await envaseAfuera(d, u, 40);
      const pedido = await pedidoDe(d, u);
      await ds.query(
        `UPDATE "order" SET scheduled_date = $2 WHERE order_id = $1`,
        [pedido, diaArgentino(new Date(T0.getTime() + 3 * DIA))],
      );

      const r = await engine.ejecutar(d, T0);
      expect(r.ofertas).toBe(1);
      const caso = await casoDe(envase);
      const oferta = (await avisosDe(caso.caseId)).find(
        (a) => a.kind === RecoveryNoticeKind.PICKUP_OFFER,
      );
      expect(oferta).toEqual(
        expect.objectContaining({ orderId: pedido, status: 'pending' }),
      );

      // Otra corrida no repite la oferta.
      expect((await engine.ejecutar(d, T0)).ofertas).toBe(0);

      // El cliente acepta; vence el escalón pero el caso espera el retiro.
      const aceptado = await cases.aceptarRetiro(caso.caseId, u, d, enDias(1));
      expect(aceptado.pickup).toEqual(
        expect.objectContaining({ status: 'accepted', orderId: pedido }),
      );
      await engine.ejecutar(d, enDias(9));
      expect((await casoDe(envase)).step).toBe(1);

      // El pedido termina sin que el chofer retire el envase: el caso sigue su secuencia.
      await ds.query(
        `UPDATE "order" SET status = 'cancelled', "cancellationReason" = 'Prueba' WHERE order_id = $1`,
        [pedido],
      );
      await engine.ejecutar(d, enDias(10));
      const despues = await casoDe(envase);
      expect(despues.step).toBe(2);
      const ofertaFinal = (await avisosDe(caso.caseId)).find(
        (a) => a.kind === RecoveryNoticeKind.PICKUP_OFFER,
      );
      expect(ofertaFinal?.status).toBe('expired');
    });

    it('lo que escribe el proceso sin request queda auditado con la distribuidora', async () => {
      const d = await nuevaDistribuidora();
      const u = await nuevoUsuario();
      armar(d);
      const envase = await envaseAfuera(d, u, 40);
      await engine.ejecutar(d, T0);
      const caso = await casoDe(envase);
      const aviso = (await avisosDe(caso.caseId))[0];
      const filas = await ds.query<
        Array<{ entity: string; record_id: string; distributor_id: string }>
      >(
        `SELECT entity, record_id, distributor_id FROM audit
          WHERE record_id IN ($1, $2) ORDER BY entity`,
        [caso.caseId, aviso.noticeId],
      );
      expect(filas.map((f) => f.entity)).toEqual(
        expect.arrayContaining([
          'CylinderRecoveryCase',
          'CylinderRecoveryNotice',
        ]),
      );
      expect(filas.map((f) => [f.entity, f.distributor_id === d])).toEqual(
        filas.map((f) => [f.entity, true]),
      );
    });

    it('un envase con cliente sin entrega registrada queda para revisión manual y no abre caso', async () => {
      const d = await nuevaDistribuidora();
      const u = await nuevoUsuario();
      armar(d);
      const c = randomUUID();
      await ds.query(
        `INSERT INTO cylinder (cylinder_id, distributor_id, serial, state, current_customer_id, deposit)
         VALUES ($1, $2, $3, 'with_customer', $4, 1000)`,
        [c, d, `SN-${c.slice(0, 8)}`.toUpperCase(), u],
      );
      const r = await engine.ejecutar(d, T0);
      expect(r.revisionManual).toBe(1);
      expect(r.abiertos).toBe(0);
    });

    it('el aislamiento por distribuidora: otra empresa no ve ni resuelve el caso', async () => {
      const d = await nuevaDistribuidora();
      const otra = await nuevaDistribuidora();
      const u = await nuevoUsuario();
      armar(d);
      const envase = await envaseAfuera(d, u, 40);
      await engine.ejecutar(d, T0);
      const caso = await casoDe(envase);
      await expect(cases.detalle(caso.caseId, otra)).rejects.toThrow(
        /no encontrado/,
      );
      expect((await cases.listar(otra, {})).total).toBe(0);
      expect((await engine.ejecutar(otra, T0)).abiertos).toBe(0);
    });

    it('la decisión y el cierre de la baja son una sola transacción', async () => {
      const d = await nuevaDistribuidora();
      const u = await nuevoUsuario();
      armar(d);
      const envase = await envaseAfuera(d, u, 40, 26000);
      await engine.ejecutar(d, T0);
      await engine.ejecutar(d, enDias(8));
      await engine.ejecutar(d, enDias(16));
      const caso = await casoDe(envase);
      // El envase vuelve justo antes de la decisión: la baja falla y el caso no se cierra mal.
      await ds.query(
        `UPDATE cylinder SET state = 'empty_returned', current_customer_id = NULL WHERE cylinder_id = $1`,
        [envase],
      );
      await expect(
        cases.resolver(
          caso.caseId,
          d,
          { decision: RecoveryDecision.WRITE_OFF, note: 'x' },
          await nuevoUsuario(),
        ),
      ).rejects.toThrow(/ya volvió o cambió de manos/);
      // El caso no se decide: se cierra como devuelto.
      expect((await casoDe(envase)).status).toBe(RecoveryCaseStatus.RETURNED);
    });
  });
});
