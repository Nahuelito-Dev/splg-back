/**
 * Hoja de ruta, etapa E3 (planificación y edición), contra la app con Postgres y
 * Redis efímeros: abrir el día → proponer → mover una parada entre hojas →
 * reordenar → confirmar → reabrir → cancelar → cerrar el día, con la versión
 * optimista (dos sesiones), el aislamiento por distribuidora (404), la matriz
 * de códigos de cada endpoint y la retención frente al despacho (M1).
 *
 * La matriz de tiempos es la de línea recta (sin OSRM): determinista.
 */
import { randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { diaArgentino } from '../../src/common/utils/dias-argentina';
import { Order } from '../../src/order/entities/order.entity';
import { DispatchOrchestratorService } from '../../src/order/application/dispatch-orchestrator.service';
import { DispatchOfferRepositoryPort } from '../../src/order/domain/ports/dispatch-offer.repository.port';
import { RealtimeDispatchPort } from '../../src/order/domain/ports/realtime-dispatch.port';
import { TimeSlot } from '../../src/time-slot/entities/time-slot.entity';
import { RoutePlanningHoldService } from '../../src/route-batch/planning-hold/route-planning-hold.service';
import { RoutePlanService } from '../../src/route-batch/application/route-plan.service';
import { diaSiguiente } from '../../src/route-batch/domain/route-sheet-rules';
import { haversineMatrix } from '../../src/routes/route-matrix';
import { RouteMatrixPort } from '../../src/routes/route-matrix.port';
import { PuntoDeRuta } from '../../src/routes/polyline';
import { conBypassManager } from './setup/bypass';
import { createTestApp, TestEnv } from './setup/test-env';
import { sembrarPedido } from './matriz-http/t2-base';
import {
  ChoferT5,
  EscenarioT5,
  nuevoChofer,
  sembrarBaseT5,
} from './matriz-http/t5-base';

interface Hoja {
  id: string;
  version: number;
  status: string;
  number: number | null;
  optimizationMethod: string | null;
  stops: Array<{
    orderId: string;
    customerName?: string | null;
    sequence: number;
    plannedEtaAt: string | null;
    etaAt: string | null;
  }>;
}
interface Dia {
  plan: { status: string; cutoffAt: string; date: string };
  sheets: Hoja[];
  unassigned: Array<{ orderId: string; blockedReason: string | null }>;
  resources: { drivers: Array<{ deliveryId: string }>; cars: unknown[] };
}

describe('Hoja de ruta: planificación y edición (e2e)', () => {
  let env: TestEnv;
  let c: EscenarioT5;
  let ds: DataSource;
  let manana: string;
  let franjaA: string;
  let ch1: ChoferT5;
  let ch2: ChoferT5;
  const pedidosDelDia: string[] = [];

  const http = () => request(env.app.getHttpServer());
  const A = () => c.actores.adminA;
  const v2 = (ruta: string) => `/v2${ruta}`;

  /** Un pedido pendiente del cliente A programado para `fecha` en la franja amplia. */
  async function pedidoPara(fecha: string): Promise<string> {
    const orderId = await sembrarPedido(c);
    await conBypassManager(ds, ['transiciones', 'reglas'], async (m) => {
      await m.query(
        `DELETE FROM "order_dispatch_offer" WHERE "order_id" = $1`,
        [orderId],
      );
      await m.update(Order, { orderId }, {
        scheduledDate: fecha,
        timeSlotId: franjaA,
      } as Partial<Order>);
      // Creado dos días antes del reparto: siempre antes del cierre (D−1 a las
      // 18), a cualquier hora que corra el test. Los tardíos se arman aparte.
      await m.query(
        `UPDATE "order" SET "createdAt" = ($2::date - 2)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires' WHERE "order_id" = $1`,
        [orderId, fecha],
      );
    });
    return orderId;
  }

  beforeAll(async () => {
    env = await createTestApp({
      overrides: [
        {
          token: RouteMatrixPort,
          value: {
            matrix: (p: readonly PuntoDeRuta[]) =>
              Promise.resolve(haversineMatrix(p)),
          },
        },
      ],
    });
    ds = env.app.get(DataSource);
    c = await sembrarBaseT5(env);
    manana = diaSiguiente(diaArgentino());
    const franja = await ds.getRepository(TimeSlot).save({
      distributorId: c.distA.id,
      name: 'Todo el día',
      startTime: '06:00',
      endTime: '22:00',
      capacity: 100,
      isActive: true,
    } as Partial<TimeSlot>);
    franjaA = franja.timeSlotId;
    ch1 = await nuevoChofer(c);
    ch2 = await nuevoChofer(c);
    for (let i = 0; i < 5; i++) pedidosDelDia.push(await pedidoPara(manana));
  }, 300000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe('acceso y validación', () => {
    it('401 sin token', async () => {
      await http()
        .get(v2(`/route-plans/${manana}`))
        .expect(401);
    });
    it('403 con rol de chofer', async () => {
      await http()
        .get(v2(`/route-plans/${manana}`))
        .set(c.actores.chofer)
        .expect(403);
    });
    it('400 con una fecha mal formada o que no existe', async () => {
      await http().get(v2('/route-plans/14-11-2026')).set(A()).expect(400);
      await http().get(v2('/route-plans/2026-02-30')).set(A()).expect(400);
    });
    it('el super admin: sin sesión de soporte 403; en modo soporte lee y no escribe', async () => {
      await http()
        .get(v2(`/route-plans/${manana}`))
        .set(c.actores.super)
        .expect(403);
      await http()
        .post(v2(`/route-plans/${manana}/open`))
        .set(c.actores.soporteA)
        .expect(403);
    });
    it('404 antes de abrir el día', async () => {
      const r = await http()
        .get(v2(`/route-plans/${manana}`))
        .set(A())
        .expect(404);
      expect((r.body as { code: string }).code).toBe('ROUTE_PLAN_NOT_FOUND');
    });
    it('409 al proponer con la hoja de ruta apagada', async () => {
      const r = await http()
        .post(v2(`/route-plans/${manana}/propose`))
        .set(A())
        .send({})
        .expect(409);
      expect((r.body as { code: string }).code).toBe('ROUTE_PLANNING_DISABLED');
    });
    it('parámetros: 400 fuera de rango, 200 al encender', async () => {
      await http()
        .patch(v2('/route-planning/settings'))
        .set(A())
        .send({ maxStopsPerSheet: 99 })
        .expect(400);
      const r = await http()
        .patch(v2('/route-planning/settings'))
        .set(A())
        .send({ enabled: 1, maxStopsPerSheet: 3 })
        .expect(200);
      expect(
        (r.body as { params: Record<string, number> }).params,
      ).toMatchObject({
        enabled: 1,
        maxStopsPerSheet: 3,
        cutoffHour: 18,
      });
      await http().get(v2('/route-planning/settings')).set(A()).expect(200);
    });
  });

  describe('circuito', () => {
    let dia: Dia;

    it('abre el día (idempotente) con el cierre a las 18 del día anterior; 409 un día pasado', async () => {
      const r1 = await http()
        .post(v2(`/route-plans/${manana}/open`))
        .set(A())
        .expect(200);
      const r2 = await http()
        .post(v2(`/route-plans/${manana}/open`))
        .set(A())
        .expect(200);
      dia = r1.body as Dia;
      expect(dia.plan.status).toBe('open');
      expect(dia.plan.cutoffAt).toBe(
        new Date(`${diaArgentino()}T21:00:00.000Z`).toISOString(),
      );
      expect((r2.body as Dia).plan.cutoffAt).toBe(dia.plan.cutoffAt);
      expect(dia.unassigned.map((u) => u.orderId)).toEqual(
        expect.arrayContaining(pedidosDelDia),
      );
      const r = await http()
        .post(v2('/route-plans/2020-01-01/open'))
        .set(A())
        .expect(409);
      expect((r.body as { code: string }).code).toBe('ROUTE_PLAN_DATE_PAST');
    });

    it('retiene los pedidos del día para el despacho (M1) mientras se planifica', async () => {
      const hoy = await pedidoPara(diaArgentino());
      const retenidos = await env.app
        .get(RoutePlanningHoldService)
        .isHeldForPlanning([...pedidosDelDia, hoy]);
      for (const id of pedidosDelDia) expect(retenidos.has(id)).toBe(true);
      expect(retenidos.has(hoy)).toBe(false);
    });

    it('propone en seco sin crear hojas y después crea los borradores', async () => {
      const seco = await http()
        .post(v2(`/route-plans/${manana}/propose`))
        .set(A())
        .send({ dryRun: true })
        .expect(200);
      const prueba = seco.body as {
        dryRun: boolean;
        sheets: Array<{ sheetId: string | null; orderIds: string[] }>;
      };
      expect(prueba.dryRun).toBe(true);
      expect(prueba.sheets.length).toBeGreaterThanOrEqual(2);
      expect(prueba.sheets.every((s) => s.sheetId === null)).toBe(true);
      expect(
        (
          await http()
            .get(v2(`/route-plans/${manana}`))
            .set(A())
            .expect(200)
        ).body,
      ).toMatchObject({ sheets: [] });

      const r = await http()
        .post(v2(`/route-plans/${manana}/propose`))
        .set(A())
        .send({})
        .expect(200);
      const p = r.body as {
        sheets: Array<{
          sheetId: string;
          orderIds: string[];
          deliveryId: string;
        }>;
        candidates: number;
      };
      expect(p.candidates).toBe(5);
      expect(p.sheets.length).toBeGreaterThanOrEqual(2);
      expect(p.sheets.every((s) => s.orderIds.length <= 3)).toBe(true);
      expect(new Set(p.sheets.map((s) => s.deliveryId)).size).toBe(
        p.sheets.length,
      );
      dia = (
        await http()
          .get(v2(`/route-plans/${manana}`))
          .set(A())
          .expect(200)
      ).body as Dia;
      expect(dia.plan.status).toBe('proposed');
      expect(dia.sheets.every((s) => s.status === 'draft')).toBe(true);
      const enHojas = dia.sheets.flatMap((s) => s.stops.map((x) => x.orderId));
      expect(enHojas.sort()).toEqual([...pedidosDelDia].sort());
      for (const s of dia.sheets) {
        expect(s.stops.map((x) => x.sequence)).toEqual(
          s.stops.map((_, i) => i + 1),
        );
        expect(s.stops.every((x) => x.etaAt !== null)).toBe(true);
      }
    });

    let origen: Hoja;
    let destino: Hoja;

    it('mueve una parada entre hojas; con la versión vieja responde 409', async () => {
      const orden = [...dia.sheets].sort(
        (a, b) => b.stops.length - a.stops.length,
      );
      origen = orden[0];
      destino = orden.find(
        (s) => s.stops.length < 3 && s.id !== origen.id,
      ) as Hoja;
      const orderId = origen.stops[0].orderId;
      const r = await http()
        .post(v2(`/route-sheets/${origen.id}/stops/${orderId}/move`))
        .set(A())
        .send({
          version: origen.version,
          targetSheetId: destino.id,
          targetVersion: destino.version,
        })
        .expect(200);
      const body = r.body as { source: Hoja; target: Hoja };
      expect(body.source.stops.map((s) => s.orderId)).not.toContain(orderId);
      expect(body.target.stops.map((s) => s.orderId)).toContain(orderId);
      expect(body.source.version).toBeGreaterThan(origen.version);
      expect(body.target.version).toBeGreaterThan(destino.version);

      const vieja = await http()
        .post(v2(`/route-sheets/${destino.id}/stops/${orderId}/move`))
        .set(A())
        .send({
          version: destino.version,
          targetSheetId: origen.id,
          targetVersion: body.source.version,
        })
        .expect(409);
      expect((vieja.body as { code: string }).code).toBe(
        'ROUTE_SHEET_VERSION_CONFLICT',
      );
      origen = body.source;
      destino = body.target;
    });

    it('mover: 400 a la misma hoja, 404 parada que no es de la hoja', async () => {
      await http()
        .post(
          v2(
            `/route-sheets/${origen.id}/stops/${origen.stops[0].orderId}/move`,
          ),
        )
        .set(A())
        .send({
          version: origen.version,
          targetSheetId: origen.id,
          targetVersion: origen.version,
        })
        .expect(400);
      await http()
        .post(v2(`/route-sheets/${origen.id}/stops/${c.inexistente}/move`))
        .set(A())
        .send({
          version: origen.version,
          targetSheetId: destino.id,
          targetVersion: destino.version,
        })
        .expect(404);
    });

    it('reordena a mano (manual); 400 si no son exactamente las paradas', async () => {
      const invertido = destino.stops.map((s) => s.orderId).reverse();
      const r = await http()
        .put(v2(`/route-sheets/${destino.id}/sequence`))
        .set(A())
        .send({
          version: destino.version,
          orderIds: invertido,
          locked: [invertido[0]],
        })
        .expect(200);
      destino = r.body as Hoja;
      expect(destino.stops.map((s) => s.orderId)).toEqual(invertido);
      expect(destino.optimizationMethod).toBe('manual');
      const mal = await http()
        .put(v2(`/route-sheets/${destino.id}/sequence`))
        .set(A())
        .send({ version: destino.version, orderIds: invertido.slice(1) })
        .expect(400);
      expect((mal.body as { code: string }).code).toBe(
        'ROUTE_SHEET_SEQUENCE_INVALID',
      );
    });

    it('re-optimiza devolviendo antes y después', async () => {
      const r = await http()
        .post(v2(`/route-sheets/${destino.id}/optimize`))
        .set(A())
        .send({ version: destino.version })
        .expect(200);
      const b = r.body as {
        before: { durationMin: number };
        after: { durationMin: number };
        sheet: Hoja;
      };
      expect(b.after.durationMin).toBeLessThanOrEqual(b.before.durationMin);
      expect(b.sheet.stops[0].orderId).toBe(destino.stops[0].orderId); // la fijada no se movió
      destino = b.sheet;
    });

    it('dos sesiones: la segunda que edita con la misma versión recibe 409', async () => {
      const salida = `${manana}T10:00:00.000Z`;
      const r = await http()
        .patch(v2(`/route-sheets/${destino.id}`))
        .set(A())
        .send({ version: destino.version, plannedStartAt: salida })
        .expect(200);
      const otra = await http()
        .patch(v2(`/route-sheets/${destino.id}`))
        .set(c.actores.adminA2)
        .send({
          version: destino.version,
          plannedStartAt: `${manana}T11:00:00.000Z`,
        })
        .expect(409);
      expect((otra.body as { code: string }).code).toBe(
        'ROUTE_SHEET_VERSION_CONFLICT',
      );
      destino = r.body as Hoja;
    });

    it('confirma: número, ETA prometida; la confirmada no se edita y el despacho no la ofrece', async () => {
      const r = await http()
        .post(v2(`/route-sheets/${destino.id}/confirm`))
        .set(A())
        .send({ version: destino.version })
        .expect(200);
      destino = r.body as Hoja;
      expect(destino.status).toBe('confirmed');
      expect(destino.number).toBeGreaterThanOrEqual(1);
      expect(destino.stops.every((s) => s.plannedEtaAt !== null)).toBe(true);
      const retenidos = await env.app
        .get(RoutePlanningHoldService)
        .isHeldForPlanning(destino.stops.map((s) => s.orderId));
      expect(retenidos.size).toBe(destino.stops.length);
      const [{ estado, chofer }] = await ds.query<
        Array<{ estado: string; chofer: string | null }>
      >(
        `SELECT "status"::text AS estado, "delivery_id" AS chofer FROM "order" WHERE "order_id" = $1`,
        [destino.stops[0].orderId],
      );
      expect({ estado, chofer }).toEqual({ estado: 'pending', chofer: null }); // confirmar no asigna (ADR-03)
      const editar = await http()
        .delete(
          v2(`/route-sheets/${destino.id}/stops/${destino.stops[0].orderId}`),
        )
        .set(A())
        .send({ version: destino.version })
        .expect(409);
      expect((editar.body as { code: string }).code).toBe(
        'ROUTE_SHEET_NOT_EDITABLE',
      );
      await http()
        .post(v2(`/route-sheets/${destino.id}/confirm`))
        .set(A())
        .send({ version: destino.version })
        .expect(409);
    });

    it('el despacho automático no ofrece las paradas de una hoja confirmada o en borrador; un pedido suelto sí', async () => {
      const orchestrator = env.app.get(DispatchOrchestratorService);
      const offers = env.app.get(DispatchOfferRepositoryPort);
      const enHoja = destino.stops[0].orderId;
      const [{ enBorrador }] = await ds.query<Array<{ enBorrador: string }>>(
        `SELECT s."order_id" AS "enBorrador" FROM "route_batch_stop" s
           JOIN "route_batch" b ON b."batch_id" = s."batch_id"
          WHERE b."distributor_id" = $1 AND b."plan_date" = $2 AND b."kind" = 'planned'
            AND b."status" = 'draft' AND s."active"
          LIMIT 1`,
        [c.distA.id, manana],
      );
      // Control: un pedido de otro día, fuera de toda hoja, con un chofer en línea al lado.
      const suelto = await pedidoPara(diaSiguiente(manana));
      const [{ lat, lng }] = await ds.query<
        Array<{ lat: number; lng: number }>
      >(
        `SELECT ST_Y("deliveryPoint"::geometry) AS lat, ST_X("deliveryPoint"::geometry) AS lng
           FROM "order" WHERE "order_id" = $1`,
        [enHoja],
      );
      await env.app
        .get(RealtimeDispatchPort)
        .reportDriverLocation(ch2.userId, Number(lat), Number(lng));
      const ofertasDe = async (orderId: string) =>
        Number(
          (
            await ds.query<Array<{ n: string }>>(
              `SELECT count(*) AS n FROM "order_dispatch_offer" WHERE "order_id" = $1`,
              [orderId],
            )
          )[0].n,
        );
      try {
        expect(await offers.isInPlannedRouteSheet(enHoja)).toBe(true);
        expect(await offers.isInPlannedRouteSheet(enBorrador)).toBe(true);
        expect(await offers.isInPlannedRouteSheet(suelto)).toBe(false);
        const pedido = (id: string) =>
          ds.getRepository(Order).findOneByOrFail({ orderId: id });
        expect(
          await orchestrator.offerToNextDriver(await pedido(enHoja)),
        ).toBeNull();
        expect(
          await orchestrator.offerToNextDriver(await pedido(enBorrador)),
        ).toBeNull();
        expect(await ofertasDe(enHoja)).toBe(0);
        expect(await ofertasDe(enBorrador)).toBe(0);
        expect(await orchestrator.offerToNextDriver(await pedido(suelto))).toBe(
          ch2.userId,
        );
        expect(await ofertasDe(suelto)).toBe(1);
      } finally {
        await conBypassManager(ds, ['transiciones', 'reglas'], (m) =>
          m.query(`DELETE FROM "order_dispatch_offer" WHERE "order_id" = $1`, [
            suelto,
          ]),
        );
      }
    });

    it('una parada de una hoja (confirmada o en borrador) no está en el pool, el chofer no la acepta y el admin no la asigna: 409 ORDER_IN_ROUTE_SHEET', async () => {
      const enHoja = destino.stops[0].orderId;
      const [{ enBorrador }] = await ds.query<Array<{ enBorrador: string }>>(
        `SELECT s."order_id" AS "enBorrador" FROM "route_batch_stop" s
           JOIN "route_batch" b ON b."batch_id" = s."batch_id"
          WHERE b."distributor_id" = $1 AND b."plan_date" = $2 AND b."kind" = 'planned'
            AND b."status" = 'draft' AND s."active"
          LIMIT 1`,
        [c.distA.id, manana],
      );
      const control = await pedidoPara(diaSiguiente(manana));
      const pool = (
        (await http().get('/orders/available?limit=100').set(A()).expect(200))
          .body as { orders: Array<{ order_id: string }> }
      ).orders.map((o) => o.order_id);
      expect(pool).not.toContain(enHoja);
      expect(pool).not.toContain(enBorrador);
      // Control: un pedido fuera de toda hoja sí aparece.
      expect(pool).toContain(control);

      for (const orderId of [enHoja, enBorrador]) {
        const acepta = await http()
          .patch(`/orders/${orderId}/status`)
          .set(c.actores.chofer)
          .send({ status: 'accepted' })
          .expect(409);
        expect(acepta.body as { code: string; message: string }).toMatchObject({
          code: 'ORDER_IN_ROUTE_SHEET',
          message: expect.stringContaining('hoja de ruta') as string,
        });
        const asigna = await http()
          .patch(`/orders/${orderId}/assign/${ch2.deliveryId}`)
          .set(A())
          .expect(409);
        expect((asigna.body as { code: string }).code).toBe(
          'ORDER_IN_ROUTE_SHEET',
        );
        const porEstado = await http()
          .patch(`/orders/${orderId}/status`)
          .set(A())
          .send({ status: 'accepted', deliveryId: ch2.deliveryId })
          .expect(409);
        expect((porEstado.body as { code: string }).code).toBe(
          'ORDER_IN_ROUTE_SHEET',
        );
      }
      const [{ estado, chofer }] = await ds.query<
        Array<{ estado: string; chofer: string | null }>
      >(
        `SELECT "status"::text AS estado, "delivery_id" AS chofer FROM "order" WHERE "order_id" = $1`,
        [enHoja],
      );
      expect({ estado, chofer }).toEqual({ estado: 'pending', chofer: null });
    });

    it('otra hoja con el mismo chofer no se confirma (409 con violaciones)', async () => {
      const r = await http()
        .patch(v2(`/route-sheets/${origen.id}`))
        .set(A())
        .send({
          version: origen.version,
          deliveryId: (await choferDe(destino.id)) as string,
        })
        .expect(409);
      expect((r.body as { code: string }).code).toBe(
        'ROUTE_SHEET_DRIVER_TAKEN',
      );
    });

    it('reabre (vuelve a borrador) y cancela: los pedidos vuelven a «sin asignar»', async () => {
      const re = await http()
        .post(v2(`/route-sheets/${destino.id}/reopen`))
        .set(A())
        .send({ version: destino.version })
        .expect(200);
      destino = re.body as Hoja;
      expect(destino.status).toBe('draft');
      await http()
        .post(v2(`/route-sheets/${destino.id}/reopen`))
        .set(A())
        .send({ version: destino.version })
        .expect(409);
      const pedidos = destino.stops.map((s) => s.orderId);
      const ca = await http()
        .post(v2(`/route-sheets/${destino.id}/cancel`))
        .set(A())
        .send({ version: destino.version })
        .expect(200);
      expect((ca.body as Hoja).status).toBe('dissolved');
      expect((ca.body as Hoja).stops).toEqual([]);
      await http()
        .post(v2(`/route-sheets/${destino.id}/cancel`))
        .set(A())
        .send({ version: (ca.body as Hoja).version })
        .expect(409);
      dia = (
        await http()
          .get(v2(`/route-plans/${manana}`))
          .set(A())
          .expect(200)
      ).body as Dia;
      expect(dia.unassigned.map((u) => u.orderId)).toEqual(
        expect.arrayContaining(pedidos),
      );
      expect(dia.sheets.map((s) => s.id)).not.toContain(destino.id);
    });

    it('agrega un pedido suelto con la inserción más barata y lo quita', async () => {
      const suelto = dia.unassigned[0].orderId;
      const hoja = dia.sheets.find((s) => s.stops.length < 3) as Hoja;
      const r = await http()
        .post(v2(`/route-sheets/${hoja.id}/stops`))
        .set(A())
        .send({ version: hoja.version, orderId: suelto })
        .expect(200);
      const con = r.body as Hoja;
      expect(con.stops.map((s) => s.orderId)).toContain(suelto);
      const dup = await http()
        .post(v2(`/route-sheets/${hoja.id}/stops`))
        .set(A())
        .send({ version: con.version, orderId: suelto })
        .expect(409);
      expect((dup.body as { code: string }).code).toBe(
        'ORDER_ALREADY_IN_ROUTE',
      );
      const q = await http()
        .delete(v2(`/route-sheets/${hoja.id}/stops/${suelto}`))
        .set(A())
        .send({ version: con.version })
        .expect(200);
      expect((q.body as Hoja).stops.map((s) => s.orderId)).not.toContain(
        suelto,
      );
      // Fuera de la hoja vuelve a estar disponible: en el pool y asignable a mano.
      const pool = (
        (await http().get('/orders/available?limit=100').set(A()).expect(200))
          .body as { orders: Array<{ order_id: string }> }
      ).orders.map((o) => o.order_id);
      expect(pool).toContain(suelto);
      const asignado = await http()
        .patch(`/orders/${suelto}/assign/${ch2.deliveryId}`)
        .set(A());
      expect(asignado.status).not.toBe(409);
      expect(asignado.status).toBe(200);
    });

    it('alta manual: 201; 404 pedido de otra distribuidora; 409 pedido de otro día', async () => {
      const otroDia = await pedidoPara(diaSiguiente(manana));
      const r = await http()
        .post(v2('/route-sheets'))
        .set(A())
        .send({
          planDate: manana,
          deliveryId: ch1.deliveryId,
          carId: ch1.carId,
        })
        .expect(201);
      expect((r.body as Hoja).status).toBe('draft');
      const deB = await sembrarPedido(c, { cliente: 'B' });
      await http()
        .post(v2('/route-sheets'))
        .set(A())
        .send({ planDate: manana, orderIds: [deB] })
        .expect(404);
      const m = await http()
        .post(v2('/route-sheets'))
        .set(A())
        .send({ planDate: manana, orderIds: [otroDia] })
        .expect(409);
      expect((m.body as { code: string }).code).toBe('ORDER_NOT_PLANNABLE');
      await http()
        .post(v2('/route-sheets'))
        .set(A())
        .send({ planDate: manana, deliveryId: c.inexistente })
        .expect(404);
      const demasiadas = await http()
        .post(v2('/route-sheets'))
        .set(A())
        .send({
          planDate: manana,
          orderIds: [randomUUID(), randomUUID(), randomUUID(), randomUUID()],
        })
        .expect(409);
      expect((demasiadas.body as { code: string }).code).toBe(
        'ROUTE_STOP_NOT_FEASIBLE',
      );
      await http()
        .post(v2('/route-sheets'))
        .set(A())
        .send({ planDate: 'mañana' })
        .expect(400);
    });

    it('otra distribuidora: 404 en la hoja, en el día y al moverle una parada', async () => {
      const hoja = dia.sheets[0];
      for (const llamada of [
        () =>
          http()
            .get(v2(`/route-sheets/${hoja.id}`))
            .set(c.actores.adminB),
        () =>
          http()
            .get(v2(`/route-sheets/${hoja.id}/load-suggestion`))
            .set(c.actores.adminB),
        () =>
          http()
            .patch(v2(`/route-sheets/${hoja.id}`))
            .set(c.actores.adminB)
            .send({ version: hoja.version }),
        () =>
          http()
            .post(v2(`/route-sheets/${hoja.id}/confirm`))
            .set(c.actores.adminB)
            .send({ version: hoja.version }),
        () =>
          http()
            .get(v2(`/route-plans/${manana}`))
            .set(c.actores.adminB),
      ]) {
        await llamada().expect(404);
      }
      const lista = await http()
        .get(v2(`/route-sheets?date=${manana}`))
        .set(c.actores.adminB)
        .expect(200);
      expect((lista.body as { total: number }).total).toBe(0);
    });

    it('listado, carga sugerida, tardíos y confirmar todas', async () => {
      const l = await http()
        .get(v2(`/route-sheets?date=${manana}&status=draft`))
        .set(A())
        .expect(200);
      expect((l.body as { total: number }).total).toBeGreaterThanOrEqual(1);
      await http().get(v2('/route-sheets?status=otro')).set(A()).expect(400);
      const hoja = dia.sheets[0];
      const carga = await http()
        .get(v2(`/route-sheets/${hoja.id}/load-suggestion`))
        .set(A())
        .expect(200);
      expect(
        (carga.body as { items: Array<{ fullUnits: number }> }).items[0]
          .fullUnits,
      ).toBeGreaterThanOrEqual(1);
      const pdf = await http()
        .get(v2(`/route-sheets/${hoja.id}/pdf`))
        .set(A())
        .buffer(true)
        .parse((res, cb) => {
          const partes: Buffer[] = [];
          res.on('data', (d: Buffer) => partes.push(d));
          res.on('end', () => cb(null, Buffer.concat(partes)));
        })
        .expect(200)
        .expect('Content-Type', /application\/pdf/);
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect(hoja.stops[0]).toMatchObject({ customerName: 'Test cliente-a' });
      // Para mirarlo a mano: HOJA_PDF=/ruta/hoja.pdf
      if (process.env.HOJA_PDF)
        writeFileSync(process.env.HOJA_PDF, pdf.body as Buffer);
      await http()
        .get(v2(`/route-sheets/${hoja.id}/pdf`))
        .set(c.actores.adminB)
        .expect(404);
      // Un pedido que entró después del cierre: aparece con la sugerencia de dónde insertarlo.
      const tardio = await pedidoPara(manana);
      await ds.query(
        `UPDATE "order" SET "createdAt" = now() WHERE "order_id" = $1`,
        [tardio],
      );
      const tardios = (
        await http()
          .get(v2(`/route-plans/${manana}/late-orders`))
          .set(A())
          .expect(200)
      ).body as Array<{
        orderId: string;
        suggestion: { sheetId: string; position: number } | null;
      }>;
      const fila = tardios.find((x) => x.orderId === tardio);
      expect(fila).toBeDefined();
      expect(fila?.suggestion?.position).toBeGreaterThanOrEqual(1);
      const todas = await http()
        .post(v2(`/route-plans/${manana}/confirm-all`))
        .set(A())
        .expect(200);
      const t = todas.body as {
        confirmed: string[];
        failed: Array<{ violations: Array<{ code: string }> }>;
      };
      expect(t.confirmed.length + t.failed.length).toBeGreaterThanOrEqual(1);
    });

    it('cierra el día: los borradores se descartan (day_closed); cerrar otra vez es 409', async () => {
      await http()
        .post(v2(`/route-plans/${manana}/close`))
        .set(A())
        .expect(200);
      const filas = await ds.query<
        Array<{ status: string; close_reason: string | null }>
      >(
        `SELECT "status"::text AS status, "close_reason"::text AS close_reason FROM "route_batch"
          WHERE "distributor_id" = $1 AND "plan_date" = $2 AND "kind" = 'planned'`,
        [c.distA.id, manana],
      );
      expect(filas.some((f) => f.status === 'draft')).toBe(false);
      // Cerrado el día, sólo retiene la hoja confirmada; lo de los borradores descartados vuelve a M1.
      const paradas = await ds.query<
        Array<{ orderId: string; status: string }>
      >(
        `SELECT s."order_id" AS "orderId", b."status"::text AS status FROM "route_batch_stop" s
           JOIN "route_batch" b ON b."batch_id" = s."batch_id"
          WHERE b."distributor_id" = $1 AND b."plan_date" = $2 AND b."kind" = 'planned'
            AND (s."active" OR b."close_reason" = 'day_closed')`,
        [c.distA.id, manana],
      );
      const confirmados = paradas
        .filter((p) => p.status === 'confirmed')
        .map((p) => p.orderId);
      const liberados = paradas
        .filter((p) => p.status === 'dissolved')
        .map((p) => p.orderId);
      expect(confirmados.length + liberados.length).toBeGreaterThanOrEqual(1);
      const retenidos = await env.app
        .get(RoutePlanningHoldService)
        .isHeldForPlanning([...confirmados, ...liberados]);
      expect([...retenidos].sort()).toEqual([...confirmados].sort());
      expect(
        filas.filter((f) => f.close_reason === 'day_closed').length,
      ).toBeGreaterThanOrEqual(1);
      const r = await http()
        .post(v2(`/route-plans/${manana}/close`))
        .set(A())
        .expect(409);
      expect((r.body as { code: string }).code).toBe('ROUTE_PLAN_CLOSED');
      await http()
        .post(v2(`/route-plans/${manana}/propose`))
        .set(A())
        .send({})
        .expect(409);
      await http()
        .post(v2('/route-sheets'))
        .set(A())
        .send({ planDate: manana })
        .expect(409);
      expect(ch2.deliveryId).toBeDefined();
    });
  });

  describe('carreras y pedidos que cambian (otro día)', () => {
    let fecha2: string;
    let nuevos: string[];
    let manual: Hoja;
    let propuesta: Hoja;

    beforeAll(async () => {
      fecha2 = diaSiguiente(manana);
      nuevos = [];
      for (let i = 0; i < 3; i++) nuevos.push(await pedidoPara(fecha2));
    });

    it('re-propuesta vs. edición: si el admin pone un pedido en una hoja mientras se arma la propuesta, ese queda sin hoja (in_route) y no hay 500', async () => {
      const plans = env.app.get(RoutePlanService);
      const original = plans.enElDia.bind(plans);
      const espia = jest
        .spyOn(plans, 'enElDia')
        .mockImplementationOnce(async (d, f, fn) => {
          // Entre la foto de la propuesta y su transacción, el admin arma una hoja a mano.
          manual = (
            await http()
              .post(v2('/route-sheets'))
              .set(A())
              .send({ planDate: fecha2, orderIds: [nuevos[0]] })
              .expect(201)
          ).body as Hoja;
          return original(d, f, fn);
        });
      try {
        const r = await http()
          .post(v2(`/route-plans/${fecha2}/propose`))
          .set(A())
          .send({});
        expect(r.status).toBe(200);
        const body = r.body as {
          sheets: Array<{ sheetId: string; orderIds: string[] }>;
          unassigned: Array<{ orderId: string; reason: string }>;
        };
        expect(body.unassigned).toContainEqual({
          orderId: nuevos[0],
          reason: 'in_route',
        });
        expect(body.sheets.flatMap((x) => x.orderIds)).not.toContain(nuevos[0]);
        expect(body.sheets.flatMap((x) => x.orderIds)).toEqual(
          expect.arrayContaining([nuevos[1], nuevos[2]]),
        );
        const [{ hojas }] = await ds.query<Array<{ hojas: string }>>(
          `SELECT count(*) AS hojas FROM "route_batch_stop" WHERE "order_id" = $1 AND "active"`,
          [nuevos[0]],
        );
        expect(Number(hojas)).toBe(1);
        propuesta = (
          await http()
            .get(
              v2(
                `/route-sheets/${body.sheets.find((x) => x.orderIds.includes(nuevos[1]))?.sheetId}`,
              ),
            )
            .set(A())
            .expect(200)
        ).body as Hoja;
      } finally {
        espia.mockRestore();
      }
    });

    it('un pedido que se cancela sale solo de su hoja (baja lógica, motivo cancelled)', async () => {
      await http()
        .patch(`/orders/${nuevos[0]}/cancel`)
        .set(A())
        .send({ reason: 'El cliente ya no lo necesita' })
        .expect(200);
      const filas = await ds.query<
        Array<{ active: boolean; removed_reason: string | null }>
      >(
        `SELECT "active", "removed_reason"::text AS removed_reason FROM "route_batch_stop" WHERE "order_id" = $1`,
        [nuevos[0]],
      );
      expect(filas).toEqual([{ active: false, removed_reason: 'cancelled' }]);
      const hoja = (
        await http()
          .get(v2(`/route-sheets/${manual.id}`))
          .set(A())
          .expect(200)
      ).body as Hoja;
      expect(hoja.stops).toEqual([]);
    });

    it('cancelar un pedido de una hoja con varias paradas: el GET muestra los totales sin esa parada (recalculados) y la versión nueva', async () => {
      interface ConTotales {
        id: string;
        version: number;
        totals: {
          units: number;
          distanceKm: number;
          durationMin: number;
          weightKg: number;
        };
        stops: Array<{ orderId: string; units: number; weightKg: number }>;
      }
      const antes = (
        await http()
          .get(v2(`/route-sheets/${propuesta.id}`))
          .set(A())
          .expect(200)
      ).body as ConTotales;
      expect(antes.stops.length).toBeGreaterThanOrEqual(2);
      const sale = antes.stops[antes.stops.length - 1];
      await http()
        .patch(`/orders/${sale.orderId}/cancel`)
        .set(A())
        .send({ reason: 'El cliente compró en otro lado' })
        .expect(200);
      // El cambio de estado no toca la fila de la hoja (sin interbloqueos): sus totales quedaron viejos.
      const [guardada] = await ds.query<Array<{ units: number }>>(
        `SELECT "total_units" AS units FROM "route_batch" WHERE "batch_id" = $1`,
        [propuesta.id],
      );
      expect(Number(guardada.units)).toBe(antes.totals.units);
      const despues = (
        await http()
          .get(v2(`/route-sheets/${propuesta.id}`))
          .set(A())
          .expect(200)
      ).body as ConTotales;
      expect(despues.stops.map((x) => x.orderId)).not.toContain(sale.orderId);
      expect(despues.totals.units).toBe(antes.totals.units - sale.units);
      expect(despues.totals.units).toBe(
        despues.stops.reduce((t, x) => t + x.units, 0),
      );
      expect(despues.totals.weightKg).toBeCloseTo(
        antes.totals.weightKg - sale.weightKg,
      );
      expect(despues.version).toBeGreaterThan(antes.version);
      propuesta = despues as unknown as Hoja;
    });

    it('confirmar revalida las paradas: un pedido que ya no es de ese día da 409 stops_not_plannable y la hoja lo avisa', async () => {
      const invalido = propuesta.stops[0].orderId;
      await conBypassManager(ds, ['transiciones', 'reglas'], (m) =>
        m.update(Order, { orderId: invalido }, {
          scheduledDate: diaSiguiente(fecha2),
        } as Partial<Order>),
      );
      const leida = (
        await http()
          .get(v2(`/route-sheets/${propuesta.id}`))
          .set(A())
          .expect(200)
      ).body as Hoja & { warnings: Array<{ code: string }> };
      expect(leida.warnings.map((w) => w.code)).toContain(
        'stops_not_plannable',
      );
      const r = await http()
        .post(v2(`/route-sheets/${propuesta.id}/confirm`))
        .set(A())
        .send({ version: leida.version, acceptLateStops: true })
        .expect(409);
      const cuerpo = r.body as {
        code: string;
        violations: Array<{ code: string; orderIds?: string[] }>;
      };
      expect(cuerpo.code).toBe('ROUTE_SHEET_NOT_CONFIRMABLE');
      expect(cuerpo.violations).toContainEqual(
        expect.objectContaining({
          code: 'stops_not_plannable',
          orderIds: [invalido],
        }),
      );
    });
  });

  async function choferDe(sheetId: string): Promise<string | null> {
    const [f] = await ds.query<Array<{ d: string | null }>>(
      `SELECT "delivery_id" AS d FROM "route_batch" WHERE "batch_id" = $1`,
      [sheetId],
    );
    return f.d;
  }
});
