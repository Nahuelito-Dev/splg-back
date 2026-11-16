/**
 * F35 E5: el recupero de envases (M5) conciliado con la cuenta de envases del
 * cliente, contra la app completa sobre un Postgres y un Redis efímeros.
 *
 * Con «Cobrar envases» encendido, de los N envases con serie que tiene un
 * cliente sólo max(0, N − propios) son reclamables (los de entrega más
 * antigua); el cobro del depósito convierte el envase en propio y la
 * devolución de un propio baja la cuenta. Apagado, M5 sigue como antes.
 *
 * Los envases afuera y los casos escalados se siembran por SQL en la base
 * efímera (con la entrega en el pasado); todo lo demás va por HTTP.
 */
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Customer } from '../../src/customer/entities/customer.entity';
import { CustomerContainerService } from '../../src/customer-container/customer-container.service';
import { CustomerContainerMovementReason } from '../../src/customer-container/entities/customer-container-movement.entity';
import {
  CylinderRecoveryAccountService,
  NOTA_CUBIERTO_POR_LA_CUENTA,
} from '../../src/cylinder/recovery/cylinder-recovery-account.service';
import { CylinderRecoveryNotifier } from '../../src/cylinder/recovery/cylinder-recovery.notifier';
import { GasCylinder } from '../../src/gascylinder/entities/gascylinder.entity';
import { createTestApp, TestApp, TestEnv } from './setup/test-env';
import {
  Cabeceras,
  Escenario,
  sembrarEscenario,
  sembrarPersona,
} from './matriz-http/matriz';

const DIA = 24 * 60 * 60 * 1000;

interface CasoFila {
  case_id: string;
  cylinder_id: string;
  status: string;
  resolution_note: string | null;
}

describe('F35 E5: recupero conciliado con la cuenta de envases (e2e)', () => {
  let env: TestEnv;
  let app: TestApp;
  let ds: DataSource;
  let e: Escenario;
  let tipoA: string;
  let tipoB: string;
  let porSocket: jest.SpyInstance;
  let alCliente: jest.SpyInstance;

  const http = (
    metodo: 'get' | 'post' | 'put' | 'patch',
    ruta: string,
    cabeceras: Cabeceras,
    body?: object,
  ) => {
    const req = request(app.getHttpServer())[metodo](ruta).set(cabeceras);
    return body === undefined ? req : req.send(body);
  };
  const adminA = () => e.actores.adminA;
  const adminB = () => e.actores.adminB;

  const nuevoTipo = async (distributorId: string, type: string) =>
    (
      (await ds.getRepository(GasCylinder).save({
        distributorId,
        type,
        price: 1000,
        containerPrice: 500,
        stock: 1000,
        weight: 10,
        isActive: true,
      } as Partial<GasCylinder>)) as GasCylinder
    ).gasCylinderId;

  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '100000';
    env = await createTestApp();
    app = env.app;
    ds = app.get(DataSource);
    e = await sembrarEscenario(app);
    tipoA = await nuevoTipo(e.distA.id, 'Garrafa 10 kg E5');
    tipoB = await nuevoTipo(e.distB.id, 'Garrafa 10 kg E5');
    // El recupero encendido en las dos; «Cobrar envases» sólo en A.
    for (const admin of [adminA(), adminB()]) {
      const r = await http('patch', '/v2/cylinder-recovery/settings', admin, {
        enabled: 1,
      });
      if (r.status !== 200) {
        throw new Error(`No se pudo encender el recupero: ${r.status}`);
      }
    }
    const cobro = await http('put', '/v2/container-charge', adminA(), {
      enabled: true,
    });
    if (cobro.status !== 200) {
      throw new Error(`No se pudo encender el cobro: ${cobro.status}`);
    }
    const notifier = app.get(CylinderRecoveryNotifier);
    porSocket = jest.spyOn(notifier, 'porSocket');
    alCliente = jest.spyOn(notifier, 'alClienteAgrupado');
  }, 300000);

  afterAll(async () => {
    if (env) await env.cleanup();
  });

  // ───────────────────────── datos ─────────────────────────

  /** Un cliente nuevo de la distribuidora: su usuario y el id de cliente de la ficha. */
  const nuevoCliente = async (distributorId: string) => {
    const p = await sembrarPersona(app, 'customer', 'cli-e5', distributorId);
    const c = await ds
      .getRepository(Customer)
      .findOneByOrFail({ userId: p.userId });
    return { userId: p.userId, customerId: c.customerId };
  };

  /** Un envase con serie en poder del cliente, entregado hace `dias` días. */
  const envaseAfuera = async (
    distributorId: string,
    clienteUserId: string,
    tipo: string,
    dias: number,
  ): Promise<string> => {
    const c = randomUUID();
    await ds.query(
      `INSERT INTO cylinder (cylinder_id, distributor_id, serial, state, current_customer_id, deposit, gas_cylinder_id)
       VALUES ($1, $2, $3, 'with_customer', $4, 70000, $5)`,
      [
        c,
        distributorId,
        `E5-${c.slice(0, 8)}`.toUpperCase(),
        clienteUserId,
        tipo,
      ],
    );
    await ds.query(
      `INSERT INTO cylinder_movement (cylinder_id, distributor_id, from_state, to_state, "createdAt")
       VALUES ($1, $2, 'dispatched', 'with_customer', $3)`,
      [c, distributorId, new Date(Date.now() - dias * DIA)],
    );
    return c;
  };

  /** Ajuste de la cuenta de envases por la API (el admin corrige los propios). */
  const ajustar = async (
    admin: Cabeceras,
    customerId: string,
    tipo: string,
    quantity: number,
  ) => {
    const r = await http(
      'post',
      `/v2/customers/${customerId}/containers/adjustments`,
      { ...admin, 'Idempotency-Key': randomUUID() },
      {
        gasCylinderId: tipo,
        quantity,
        note: 'Ajuste de prueba de la conciliación E5',
      },
    );
    expect(r.status).toBe(201);
  };

  const correr = async (admin: Cabeceras) => {
    const r = await http('post', '/v2/cylinder-recovery/run', admin);
    expect(r.status).toBe(201);
    return r.body as {
      opened: number;
      closedCoveredByOwned: number;
      manualReview: number;
    };
  };

  const casosDe = (userId: string): Promise<CasoFila[]> =>
    ds.query(
      `SELECT case_id, cylinder_id, status, resolution_note
         FROM cylinder_recovery_case WHERE user_id = $1 ORDER BY delivered_at`,
      [userId],
    );
  const vivos = async (userId: string) =>
    (await casosDe(userId)).filter((c) =>
      ['open', 'escalated', 'lost'].includes(c.status),
    );

  const cuenta = async (admin: Cabeceras, customerId: string, tipo: string) => {
    const r = await http(
      'get',
      `/v2/customers/${customerId}/containers`,
      admin,
    );
    expect(r.status).toBe(200);
    const items = (
      r.body as {
        items: Array<{
          gasCylinderId: string;
          owned: number;
          loanedByM5: number;
        }>;
      }
    ).items;
    return items.find((i) => i.gasCylinderId === tipo);
  };
  const movimientos = async (admin: Cabeceras, customerId: string) => {
    const r = await http(
      'get',
      `/v2/customers/${customerId}/containers/movements`,
      admin,
    );
    expect(r.status).toBe(200);
    return (
      r.body as {
        items: Array<{ reason: string; quantity: number; note: string | null }>;
      }
    ).items;
  };

  /** Pasa el caso a escalado (agotó la secuencia) para que el administrador lo decida. */
  const escalar = (caseId: string) =>
    ds.query(
      `UPDATE cylinder_recovery_case
          SET status = 'escalated', step = 3, exhausted_at = now()
        WHERE case_id = $1`,
      [caseId],
    );

  const resolver = (
    admin: Cabeceras,
    caseId: string,
    decision: string,
    note = 'Decisión de prueba del administrador',
  ) =>
    http('post', `/v2/cylinder-recovery/cases/${caseId}/resolve`, admin, {
      decision,
      note,
    });

  const esperar = async (cond: () => Promise<boolean>) => {
    for (let i = 0; i < 50; i++) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('No se cumplió a tiempo');
  };

  // ───────────────────────── regla de reclamables ─────────────────────────

  describe('reclamables = max(0, N − propios)', () => {
    it('N=3 y 1 propio: abre 2 casos, por las 2 entregas más antiguas', async () => {
      const cli = await nuevoCliente(e.distA.id);
      const viejo = await envaseAfuera(e.distA.id, cli.userId, tipoA, 60);
      const medio = await envaseAfuera(e.distA.id, cli.userId, tipoA, 50);
      const nuevo = await envaseAfuera(e.distA.id, cli.userId, tipoA, 40);
      await ajustar(adminA(), cli.customerId, tipoA, 1);

      await correr(adminA());
      const casos = await vivos(cli.userId);
      expect(casos.map((c) => c.cylinder_id)).toEqual([viejo, medio]);
      expect(casos.map((c) => c.cylinder_id)).not.toContain(nuevo);
      expect(await cuenta(adminA(), cli.customerId, tipoA)).toEqual(
        expect.objectContaining({ owned: 1, loanedByM5: 2 }),
      );

      // Otra corrida no abre ni cierra nada de este cliente.
      await correr(adminA());
      expect((await vivos(cli.userId)).map((c) => c.cylinder_id)).toEqual([
        viejo,
        medio,
      ]);
    });

    it.each([
      [3, 0],
      [5, 0],
    ])(
      'N=3 y %i propios: no abre ningún caso',
      async (propios, reclamables) => {
        const cli = await nuevoCliente(e.distA.id);
        for (const dias of [60, 50, 40]) {
          await envaseAfuera(e.distA.id, cli.userId, tipoA, dias);
        }
        await ajustar(adminA(), cli.customerId, tipoA, propios);
        await correr(adminA());
        expect(await casosDe(cli.userId)).toEqual([]);
        expect(await cuenta(adminA(), cli.customerId, tipoA)).toEqual(
          expect.objectContaining({ owned: propios, loanedByM5: reclamables }),
        );
      },
    );

    it('una compra que baja los reclamables cierra sin cargo el caso más nuevo, sin avisar', async () => {
      const cli = await nuevoCliente(e.distA.id);
      const viejo = await envaseAfuera(e.distA.id, cli.userId, tipoA, 60);
      const medio = await envaseAfuera(e.distA.id, cli.userId, tipoA, 50);
      await envaseAfuera(e.distA.id, cli.userId, tipoA, 40);
      await ajustar(adminA(), cli.customerId, tipoA, 1);
      await correr(adminA());
      const [casoViejo, casoMedio] = await vivos(cli.userId);
      expect([casoViejo.cylinder_id, casoMedio.cylinder_id]).toEqual([
        viejo,
        medio,
      ]);

      // El cliente compra un envase en un pedido (lo que asienta la entrega).
      await ds.transaction((manager) =>
        app.get(CustomerContainerService).registrar(manager, {
          distributorId: e.distA.id,
          customerUserId: cli.userId,
          gasCylinderId: tipoA,
          quantity: 1,
          reason: CustomerContainerMovementReason.PURCHASED,
        }),
      );
      porSocket.mockClear();
      alCliente.mockClear();
      const r = await correr(adminA());
      expect(r.closedCoveredByOwned).toBe(1);

      const casos = await casosDe(cli.userId);
      expect(casos.find((c) => c.case_id === casoViejo.case_id)?.status).toBe(
        'open',
      );
      expect(casos.find((c) => c.case_id === casoMedio.case_id)).toEqual(
        expect.objectContaining({
          status: 'closed_no_charge',
          resolution_note: NOTA_CUBIERTO_POR_LA_CUENTA,
        }),
      );
      // Sin aviso al cliente por el cierre.
      const avisados = [
        ...(porSocket.mock.calls as unknown[][]),
        ...(alCliente.mock.calls as unknown[][]),
      ]
        .flat()
        .map((a) => JSON.stringify(a));
      expect(avisados.join(' ')).not.toContain(casoMedio.case_id);
      expect(await cuenta(adminA(), cli.customerId, tipoA)).toEqual(
        expect.objectContaining({ owned: 2, loanedByM5: 1 }),
      );
    });
  });

  // ───────────────────────── cobro del depósito ─────────────────────────

  describe('charge_deposit convierte el envase en propio', () => {
    it('suma uno a la cuenta con un movimiento purchased; el otro sigue reclamado', async () => {
      const cli = await nuevoCliente(e.distA.id);
      const viejo = await envaseAfuera(e.distA.id, cli.userId, tipoA, 60);
      const nuevo = await envaseAfuera(e.distA.id, cli.userId, tipoA, 40);
      await correr(adminA());
      const [casoViejo, casoNuevo] = await vivos(cli.userId);
      expect([casoViejo.cylinder_id, casoNuevo.cylinder_id]).toEqual([
        viejo,
        nuevo,
      ]);
      await escalar(casoViejo.case_id);

      const r = await resolver(adminA(), casoViejo.case_id, 'charge_deposit');
      expect(r.status).toBe(201);
      expect((r.body as { status: string }).status).toBe('deposit_charged');
      expect(await cuenta(adminA(), cli.customerId, tipoA)).toEqual(
        expect.objectContaining({ owned: 1, loanedByM5: 1 }),
      );
      expect(await movimientos(adminA(), cli.customerId)).toEqual([
        expect.objectContaining({
          reason: 'purchased',
          quantity: 1,
          note: expect.stringContaining('Depósito cobrado') as string,
        }),
      ]);

      // El envase cobrado es el propio: el más nuevo sigue siendo reclamable.
      const corrida = await correr(adminA());
      expect(corrida.opened).toBe(0);
      expect((await vivos(cli.userId)).map((c) => c.case_id)).toEqual([
        casoNuevo.case_id,
      ]);
    });

    it('si la cuenta falla, la decisión revierte (500 y el caso sigue escalado)', async () => {
      const cli = await nuevoCliente(e.distA.id);
      await envaseAfuera(e.distA.id, cli.userId, tipoA, 60);
      await correr(adminA());
      const [caso] = await vivos(cli.userId);
      await escalar(caso.case_id);
      // Una regla temporal en la base efímera hace fallar el asiento de la compra.
      await ds.query(
        `ALTER TABLE customer_container_movement
           ADD CONSTRAINT "CHK_e5_falla_la_cuenta" CHECK (reason <> 'purchased') NOT VALID`,
      );
      try {
        const r = await resolver(adminA(), caso.case_id, 'charge_deposit');
        expect(r.status).toBe(500);
      } finally {
        await ds.query(
          `ALTER TABLE customer_container_movement DROP CONSTRAINT "CHK_e5_falla_la_cuenta"`,
        );
      }
      expect((await casosDe(cli.userId))[0].status).toBe('escalated');
      expect(await cuenta(adminA(), cli.customerId, tipoA)).toEqual(
        expect.objectContaining({ owned: 0 }),
      );
      expect(await movimientos(adminA(), cli.customerId)).toEqual([]);

      // Sin la falla, la misma decisión pasa.
      const r = await resolver(adminA(), caso.case_id, 'charge_deposit');
      expect(r.status).toBe(201);
      expect(await cuenta(adminA(), cli.customerId, tipoA)).toEqual(
        expect.objectContaining({ owned: 1 }),
      );
    });

    it('write_off y close_no_charge no tocan la cuenta', async () => {
      const cli = await nuevoCliente(e.distA.id);
      await envaseAfuera(e.distA.id, cli.userId, tipoA, 60);
      await envaseAfuera(e.distA.id, cli.userId, tipoA, 50);
      await correr(adminA());
      const [a, b] = await vivos(cli.userId);
      await escalar(a.case_id);
      await escalar(b.case_id);
      expect((await resolver(adminA(), a.case_id, 'write_off')).status).toBe(
        201,
      );
      expect(
        (await resolver(adminA(), b.case_id, 'close_no_charge')).status,
      ).toBe(201);
      expect(await movimientos(adminA(), cli.customerId)).toEqual([]);
    });

    it('otra distribuidora no decide el caso (404) y un caso ya decidido da 409', async () => {
      const cli = await nuevoCliente(e.distA.id);
      await envaseAfuera(e.distA.id, cli.userId, tipoA, 60);
      await correr(adminA());
      const [caso] = await vivos(cli.userId);
      await escalar(caso.case_id);
      expect(
        (await resolver(adminB(), caso.case_id, 'charge_deposit')).status,
      ).toBe(404);
      expect(
        (await resolver(adminA(), caso.case_id, 'charge_deposit')).status,
      ).toBe(201);
      expect(
        (await resolver(adminA(), caso.case_id, 'charge_deposit')).status,
      ).toBe(409);
      // El 409 no volvió a sumar.
      expect(await cuenta(adminA(), cli.customerId, tipoA)).toEqual(
        expect.objectContaining({ owned: 1 }),
      );
      expect(
        (
          await http(
            'get',
            `/v2/customers/${cli.customerId}/containers`,
            adminB(),
          )
        ).status,
      ).toBe(404);
    });
  });

  // ───────────────────────── devolución de un propio ─────────────────────────

  describe('devolución de un envase propio', () => {
    const devolver = async (cylinderId: string) => {
      const r = await http(
        'patch',
        `/cylinders/${cylinderId}/transition`,
        adminA(),
        { toState: 'empty_returned', note: 'Devolución en el depósito' },
      );
      expect(r.status).toBe(200);
    };

    it('registra returned y baja los propios; nunca por debajo de los envases en su poder ni de cero', async () => {
      const cli = await nuevoCliente(e.distA.id);
      const a = await envaseAfuera(e.distA.id, cli.userId, tipoA, 10);
      const b = await envaseAfuera(e.distA.id, cli.userId, tipoA, 5);
      await ajustar(adminA(), cli.customerId, tipoA, 3);

      // 3 propios y 2 en su poder: al volver uno quedan 2 propios.
      await devolver(a);
      await esperar(async () =>
        (await movimientos(adminA(), cli.customerId)).some(
          (m) => m.reason === 'returned',
        ),
      );
      expect(await cuenta(adminA(), cli.customerId, tipoA)).toEqual(
        expect.objectContaining({ owned: 2 }),
      );
      // Al volver el otro, 0 en su poder: baja a 1.
      await devolver(b);
      await esperar(
        async () =>
          (await movimientos(adminA(), cli.customerId)).filter(
            (m) => m.reason === 'returned',
          ).length === 2,
      );
      const movs = await movimientos(adminA(), cli.customerId);
      expect(movs.filter((m) => m.reason === 'returned')).toEqual([
        expect.objectContaining({ quantity: -1 }),
        expect.objectContaining({ quantity: -1 }),
      ]);
      expect(await cuenta(adminA(), cli.customerId, tipoA)).toEqual(
        expect.objectContaining({ owned: 1 }),
      );
    });

    it('la devolución de un envase prestado (propios ≤ en su poder) no toca la cuenta', async () => {
      const cli = await nuevoCliente(e.distA.id);
      const a = await envaseAfuera(e.distA.id, cli.userId, tipoA, 10);
      await envaseAfuera(e.distA.id, cli.userId, tipoA, 5);
      await ajustar(adminA(), cli.customerId, tipoA, 1);
      await devolver(a);
      // El evento corre después del commit: se le da tiempo antes de mirar.
      await new Promise((r) => setTimeout(r, 1000));
      expect(
        (await movimientos(adminA(), cli.customerId)).map((m) => m.reason),
      ).toEqual(['manual_adjustment']);
      expect(await cuenta(adminA(), cli.customerId, tipoA)).toEqual(
        expect.objectContaining({ owned: 1 }),
      );
    });
  });

  // ───────────────────────── apagado y aislamiento ─────────────────────────

  describe('corrección 1: atomicidad de la devolución', () => {
    it('si el descuento de la cuenta falla, la devolución revierte (500): el envase sigue con el cliente y owned no cambia', async () => {
      const cli = await nuevoCliente(e.distA.id);
      const a = await envaseAfuera(e.distA.id, cli.userId, tipoA, 10);
      await ajustar(adminA(), cli.customerId, tipoA, 2);
      // Una regla temporal en la base efímera hace fallar el asiento de la devolución.
      await ds.query(
        `ALTER TABLE customer_container_movement
           ADD CONSTRAINT "CHK_e5_falla_la_devolucion" CHECK (reason <> 'returned') NOT VALID`,
      );
      try {
        const r = await http('patch', `/cylinders/${a}/transition`, adminA(), {
          toState: 'empty_returned',
          note: 'Devolución que tiene que revertir',
        });
        expect(r.status).toBe(500);
      } finally {
        await ds.query(
          `ALTER TABLE customer_container_movement DROP CONSTRAINT "CHK_e5_falla_la_devolucion"`,
        );
      }
      const [envase] = await ds.query<
        Array<{ state: string; current_customer_id: string | null }>
      >(
        `SELECT state, current_customer_id FROM cylinder WHERE cylinder_id = $1`,
        [a],
      );
      expect(envase).toEqual({
        state: 'with_customer',
        current_customer_id: cli.userId,
      });
      const [{ n }] = await ds.query<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM cylinder_movement
          WHERE cylinder_id = $1 AND to_state = 'empty_returned'`,
        [a],
      );
      expect(n).toBe(0);
      expect(await cuenta(adminA(), cli.customerId, tipoA)).toEqual(
        expect.objectContaining({ owned: 2 }),
      );
      expect(
        (await movimientos(adminA(), cli.customerId)).map((m) => m.reason),
      ).toEqual(['manual_adjustment']);

      // Sin la falla, la misma devolución pasa y descuenta en el acto (sin esperar al evento).
      const ok = await http('patch', `/cylinders/${a}/transition`, adminA(), {
        toState: 'empty_returned',
      });
      expect(ok.status).toBe(200);
      expect(await cuenta(adminA(), cli.customerId, tipoA)).toEqual(
        expect.objectContaining({ owned: 1 }),
      );
    });
  });

  describe('corrección 1: el cierre por cobertura relee bajo lock', () => {
    /** La corrida calcula `cubiertos` y, antes de cerrar, pasa `entreMedio`. */
    const conCambioEntreMedio = (entreMedio: () => Promise<void>) => {
      const cuentaSvc = app.get(CylinderRecoveryAccountService);
      const original = cuentaSvc.cubiertos.bind(cuentaSvc);
      return jest
        .spyOn(cuentaSvc, 'cubiertos')
        .mockImplementationOnce(async (d: string) => {
          const foto = await original(d);
          await entreMedio();
          return foto;
        });
    };

    it('si entre el cálculo y el cierre los propios bajan, el caso no se cierra', async () => {
      const cli = await nuevoCliente(e.distA.id);
      await envaseAfuera(e.distA.id, cli.userId, tipoA, 60);
      const nuevo = await envaseAfuera(e.distA.id, cli.userId, tipoA, 40);
      await correr(adminA());
      const casoNuevo = (await vivos(cli.userId)).find(
        (c) => c.cylinder_id === nuevo,
      );
      await ajustar(adminA(), cli.customerId, tipoA, 1);
      const spy = conCambioEntreMedio(() =>
        ajustar(adminA(), cli.customerId, tipoA, -1),
      );
      try {
        const r = await correr(adminA());
        expect(spy).toHaveBeenCalled();
        expect(r.closedCoveredByOwned).toBe(0);
      } finally {
        spy.mockRestore();
      }
      expect(
        (await casosDe(cli.userId)).find(
          (c) => c.case_id === casoNuevo?.case_id,
        )?.status,
      ).toBe('open');
    });

    it('si entre el cálculo y el cierre el envase volvió, se cierra como devuelto y no por la cuenta', async () => {
      const cli = await nuevoCliente(e.distA.id);
      await envaseAfuera(e.distA.id, cli.userId, tipoA, 60);
      const nuevo = await envaseAfuera(e.distA.id, cli.userId, tipoA, 40);
      await correr(adminA());
      const casoNuevo = (await vivos(cli.userId)).find(
        (c) => c.cylinder_id === nuevo,
      );
      await ajustar(adminA(), cli.customerId, tipoA, 1);
      const spy = conCambioEntreMedio(async () => {
        // Directo en la base efímera: sin el evento, el caso queda vivo hasta el cierre.
        await ds.query(
          `UPDATE cylinder SET state = 'empty_returned', current_customer_id = NULL WHERE cylinder_id = $1`,
          [nuevo],
        );
      });
      try {
        await correr(adminA());
      } finally {
        spy.mockRestore();
      }
      const caso = (await casosDe(cli.userId)).find(
        (c) => c.case_id === casoNuevo?.case_id,
      );
      expect(caso?.status).toBe('returned');
      expect(caso?.resolution_note).toBeNull();
    });
  });

  describe('con «Cobrar envases» apagado (distribuidora B), M5 como antes', () => {
    it('reclama todos los envases, el cobro no suma propios y la devolución no los baja', async () => {
      const cli = await nuevoCliente(e.distB.id);
      const viejo = await envaseAfuera(e.distB.id, cli.userId, tipoB, 60);
      await envaseAfuera(e.distB.id, cli.userId, tipoB, 50);
      const nuevo = await envaseAfuera(e.distB.id, cli.userId, tipoB, 40);
      await ajustar(adminB(), cli.customerId, tipoB, 2);

      await correr(adminB());
      expect(await vivos(cli.userId)).toHaveLength(3);
      expect(await cuenta(adminB(), cli.customerId, tipoB)).toEqual(
        expect.objectContaining({ owned: 2, loanedByM5: 3 }),
      );

      const [caso] = await vivos(cli.userId);
      expect(caso.cylinder_id).toBe(viejo);
      await escalar(caso.case_id);
      expect(
        (await resolver(adminB(), caso.case_id, 'charge_deposit')).status,
      ).toBe(201);
      expect(await cuenta(adminB(), cli.customerId, tipoB)).toEqual(
        expect.objectContaining({ owned: 2 }),
      );

      const r = await http(
        'patch',
        `/cylinders/${nuevo}/transition`,
        adminB(),
        { toState: 'empty_returned' },
      );
      expect(r.status).toBe(200);
      await new Promise((res) => setTimeout(res, 1000));
      expect(
        (await movimientos(adminB(), cli.customerId)).map((m) => m.reason),
      ).toEqual(['manual_adjustment']);
    });
  });

  describe('aislamiento por distribuidora', () => {
    it('los propios de un cliente en B no cubren sus envases en A, y la corrida de B no toca A', async () => {
      const cli = await nuevoCliente(e.distA.id);
      await ds.query(
        `INSERT INTO customer_distributor (user_id, distributor_id, removed_at) VALUES ($1, $2, NULL)`,
        [cli.userId, e.distB.id],
      );
      await envaseAfuera(e.distA.id, cli.userId, tipoA, 60);
      // Propios en B (otro tipo, otra distribuidora).
      await ajustar(adminB(), cli.customerId, tipoB, 5);
      await http('put', '/v2/container-charge', adminB(), { enabled: true });
      try {
        await correr(adminB());
        expect(await casosDe(cli.userId)).toEqual([]);
        await correr(adminA());
        expect(await vivos(cli.userId)).toHaveLength(1);
        // Encendido en B, su corrida no cierra el caso de A.
        await correr(adminB());
        expect(await vivos(cli.userId)).toHaveLength(1);
      } finally {
        await http('put', '/v2/container-charge', adminB(), {
          enabled: false,
        });
      }
    });
  });
});
