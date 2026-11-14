/**
 * Hoja de ruta, etapas E4 (ejecución) y E5 (hora estimada), contra la app con
 * Postgres y Redis efímeros: confirmar una hoja de hoy → el chofer la inicia
 * (con su carga en la calle) → en camino → «Llegué» → entregada → no entregada
 * → el panel cancela, reasigna, agrega y saca paradas en curso → cierre (solo y
 * a mano); la matriz de códigos de cada endpoint, el aislamiento por
 * distribuidora y por chofer (404), el modo soporte (lee, no escribe), dos
 * inicios a la vez y la hora estimada que ve el cliente.
 *
 * La matriz de tiempos es la de línea recta (sin OSRM): determinista.
 */
import request from 'supertest';
import { DataSource } from 'typeorm';
import { diaArgentino } from '../../src/common/utils/dias-argentina';
import { Order } from '../../src/order/entities/order.entity';
import { TimeSlot } from '../../src/time-slot/entities/time-slot.entity';
import { diaSiguiente } from '../../src/route-batch/domain/route-sheet-rules';
import { diaHabilSiguiente } from '../../src/route-batch/domain/route-sheet-execution';
import { haversineMatrix } from '../../src/routes/route-matrix';
import { RouteMatrixPort } from '../../src/routes/route-matrix.port';
import { PuntoDeRuta } from '../../src/routes/polyline';
import { conBypassManager } from './setup/bypass';
import { entregarComoAdmin } from './setup/entrega-admin';
import { createTestApp, TestEnv } from './setup/test-env';
import { sembrarPedido } from './matriz-http/t2-base';
import {
  ChoferT5,
  EscenarioT5,
  nuevoChofer,
  sembrarBaseT5,
  sembrarCarga,
} from './matriz-http/t5-base';

interface Hoja {
  id: string;
  version: number;
  status: string;
  stops: Array<{ orderId: string; sequence: number }>;
}
interface Ejecucion {
  id: string;
  status: string;
  version: number;
  currentOrderId: string | null;
  nextOrderId: string | null;
  closeNote: string | null;
  truckLoadId: string | null;
  progress: {
    total: number;
    delivered: number;
    failed: number;
    removed: number;
    pending: number;
  };
  stops: Array<{
    orderId: string;
    sequence: number | null;
    progress: string;
    removedReason: string | null;
    removedNote: string | null;
    arrivedAt: string | null;
    etaAt: string | null;
    failedAttempts: number;
    lastFailureNote: string | null;
    rescheduledTo: string | null;
    awaitingAdmin: boolean;
  }>;
  assignedAt: string | null;
}
type Cuerpo = { code?: string; [k: string]: unknown };

describe('Hoja de ruta: ejecución y hora estimada (e2e)', () => {
  let env: TestEnv;
  let c: EscenarioT5;
  let ds: DataSource;
  let hoy: string;
  let franja: string;

  const http = () => request(env.app.getHttpServer());
  const v2 = (ruta: string) => `/v2${ruta}`;
  const A = () => c.actores.adminA;
  const codigo = (r: { body: unknown }) => (r.body as Cuerpo).code;

  /** Un pedido pendiente del cliente A para `fecha`, en la franja de todo el día. */
  async function pedidoPara(fecha: string): Promise<string> {
    const orderId = await sembrarPedido(c);
    await conBypassManager(ds, ['transiciones', 'reglas'], async (m) => {
      await m.query(
        `DELETE FROM "order_dispatch_offer" WHERE "order_id" = $1`,
        [orderId],
      );
      await m.update(Order, { orderId }, {
        scheduledDate: fecha,
        timeSlotId: franja,
      } as Partial<Order>);
      await m.query(
        `UPDATE "order" SET "createdAt" = ($2::date - 2)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires' WHERE "order_id" = $1`,
        [orderId, fecha],
      );
    });
    return orderId;
  }

  /** Una hoja confirmada de `fecha` para el chofer, con `n` pedidos nuevos (o los dados). */
  async function hojaConfirmada(
    ch: ChoferT5,
    o: { n?: number; fecha?: string; carId?: string; pedidos?: string[] } = {},
  ): Promise<Hoja> {
    const fecha = o.fecha ?? hoy;
    const pedidos = o.pedidos ?? [];
    for (let i = pedidos.length; i < (o.n ?? 2); i++) {
      pedidos.push(await pedidoPara(fecha));
    }
    const alta = await http()
      .post(v2('/route-sheets'))
      .set(A())
      .send({
        planDate: fecha,
        deliveryId: ch.deliveryId,
        carId: o.carId ?? ch.carId,
        orderIds: pedidos,
      });
    if (alta.status !== 201) {
      throw new Error(
        `alta de la hoja: ${alta.status} ${JSON.stringify(alta.body)}`,
      );
    }
    const borrador = alta.body as Hoja;
    const conf = await http()
      .post(v2(`/route-sheets/${borrador.id}/confirm`))
      .set(A())
      .send({ version: borrador.version, acceptLateStops: true });
    if (conf.status !== 200) {
      throw new Error(`confirmar: ${conf.status} ${JSON.stringify(conf.body)}`);
    }
    return conf.body as Hoja;
  }

  const seguimiento = async (id: string): Promise<Ejecucion> =>
    (
      await http()
        .get(v2(`/route-sheets/${id}/execution`))
        .set(A())
        .expect(200)
    ).body as Ejecucion;

  const pedidoEnBase = async (orderId: string) =>
    (
      await ds.query<Array<{ estado: string; chofer: string | null }>>(
        `SELECT "status"::text AS estado, "delivery_id" AS chofer FROM "order" WHERE "order_id" = $1`,
        [orderId],
      )
    )[0];

  /** Lo que hace el aviso después del commit es asíncrono: se espera a que se vea. */
  async function esperar<T>(
    leer: () => Promise<T>,
    listo: (v: T) => boolean,
    ms = 8000,
  ): Promise<T> {
    const hasta = Date.now() + ms;
    for (;;) {
      const v = await leer();
      if (listo(v) || Date.now() > hasta) return v;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  /** Un chofer con su carga ya en la calle (10 llenas). */
  async function choferEnLaCalle(): Promise<ChoferT5> {
    const ch = await nuevoChofer(c);
    await sembrarCarga(c, { chofer: ch, estado: 'on_route', llenas: 10 });
    return ch;
  }

  const iniciar = (ch: ChoferT5, id: string, body: object = {}) =>
    http()
      .post(v2(`/driver/route-sheets/${id}/start`))
      .set(ch.cabeceras)
      .send(body);

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
    hoy = diaArgentino();
    franja = (
      await ds.getRepository(TimeSlot).save({
        distributorId: c.distA.id,
        name: 'Todo el día',
        startTime: '00:00',
        endTime: '23:59',
        capacity: 1000,
        isActive: true,
      } as Partial<TimeSlot>)
    ).timeSlotId;
    await http()
      .patch(v2('/route-planning/settings'))
      .set(A())
      .send({ enabled: 1 })
      .expect(200);
  }, 300000);

  afterAll(async () => {
    await env?.cleanup();
  });

  describe('iniciar la hoja', () => {
    it('acceso: 401 sin token, 403 con otro rol, 400 id mal formado o cuerpo inválido', async () => {
      await http()
        .post(v2(`/driver/route-sheets/${c.inexistente}/start`))
        .expect(401);
      await http()
        .post(v2(`/driver/route-sheets/${c.inexistente}/start`))
        .set(A())
        .expect(403);
      await http()
        .post(v2(`/route-sheets/${c.inexistente}/start`))
        .set(c.actores.clienteA)
        .expect(403);
      const ch = await nuevoChofer(c);
      await http()
        .post(v2('/driver/route-sheets/no-es-uuid/start'))
        .set(ch.cabeceras)
        .expect(400);
      await http()
        .post(v2(`/driver/route-sheets/${c.inexistente}/start`))
        .set(ch.cabeceras)
        .send({ acknowledgeShortages: 'si' })
        .expect(400);
    });

    it('404: no existe, es de otro chofer o de otra distribuidora', async () => {
      const ch = await choferEnLaCalle();
      const otro = await nuevoChofer(c);
      const hoja = await hojaConfirmada(ch);
      expect(codigo(await iniciar(ch, c.inexistente).expect(404))).toBe(
        'ROUTE_SHEET_NOT_FOUND',
      );
      expect(codigo(await iniciar(otro, hoja.id).expect(404))).toBe(
        'ROUTE_SHEET_NOT_FOUND',
      );
      expect(
        codigo(
          await http()
            .post(v2(`/route-sheets/${hoja.id}/start`))
            .set(c.actores.adminB)
            .send({})
            .expect(404),
        ),
      ).toBe('ROUTE_SHEET_NOT_FOUND');
      // La hoja de hoy ya es del chofer (se le asignó al confirmarla), pero el
      // viaje no empezó.
      for (const s of hoja.stops) {
        expect(await pedidoEnBase(s.orderId)).toEqual({
          estado: 'accepted',
          chofer: ch.deliveryId,
        });
      }
      expect((await seguimiento(hoja.id)).status).toBe('confirmed');
    });

    it('confirmar: una hoja de hoy queda asignada a su chofer en el acto; una de mañana queda retenida sin asignar', async () => {
      const ch = await choferEnLaCalle();
      const deHoy = await hojaConfirmada(ch, { n: 1 });
      expect((await seguimiento(deHoy.id)).assignedAt).not.toBeNull();
      expect(await pedidoEnBase(deHoy.stops[0].orderId)).toEqual({
        estado: 'accepted',
        chofer: ch.deliveryId,
      });
      const otro = await nuevoChofer(c);
      const deManana = await hojaConfirmada(otro, {
        fecha: diaSiguiente(hoy),
        n: 1,
      });
      expect((await seguimiento(deManana.id)).assignedAt).toBeNull();
      expect(await pedidoEnBase(deManana.stops[0].orderId)).toEqual({
        estado: 'pending',
        chofer: null,
      });
      // Reabrir la de hoy le libera los pedidos al chofer.
      const actual = await seguimiento(deHoy.id);
      await http()
        .post(v2(`/route-sheets/${deHoy.id}/reopen`))
        .set(A())
        .send({ version: actual.version })
        .expect(200);
      expect(await pedidoEnBase(deHoy.stops[0].orderId)).toEqual({
        estado: 'pending',
        chofer: null,
      });
    });

    it('409: borrador (NOT_STARTABLE), de mañana (NOT_TODAY) y con otro vehículo en uso (CAR_NOT_IN_USE)', async () => {
      const ch = await choferEnLaCalle();
      const alta = await http()
        .post(v2('/route-sheets'))
        .set(A())
        .send({
          planDate: hoy,
          deliveryId: ch.deliveryId,
          carId: ch.carId,
          orderIds: [await pedidoPara(hoy)],
        })
        .expect(201);
      expect(
        codigo(await iniciar(ch, (alta.body as Hoja).id).expect(409)),
      ).toBe('ROUTE_SHEET_NOT_STARTABLE');
      await http()
        .post(v2(`/route-sheets/${(alta.body as Hoja).id}/cancel`))
        .set(A())
        .send({ version: (alta.body as Hoja).version })
        .expect(200);

      const deManana = await hojaConfirmada(await nuevoChofer(c), {
        fecha: diaSiguiente(hoy),
        n: 1,
      });
      const manana = await http()
        .post(v2(`/route-sheets/${deManana.id}/start`))
        .set(A())
        .send({})
        .expect(409);
      expect(codigo(manana)).toBe('ROUTE_SHEET_NOT_TODAY');

      const otroAuto = await hojaConfirmada(ch, { n: 1, carId: c.autoA });
      const r = await iniciar(ch, otroAuto.id).expect(409);
      expect(r.body).toMatchObject({ code: 'ROUTE_SHEET_CAR_NOT_IN_USE' });
    });

    it('carga obligatoria: sin abrir (409 REQUIRED, exija o no la distribuidora), sin salir (409 NOT_READY); faltantes 409 SHORTAGES y con confirmación sale', async () => {
      const sinCarga = await nuevoChofer(c);
      const hojaSin = await hojaConfirmada(sinCarga, { n: 1 });
      expect(codigo(await iniciar(sinCarga, hojaSin.id).expect(409))).toBe(
        'ROUTE_SHEET_TRUCK_LOAD_REQUIRED',
      );

      const cargando = await nuevoChofer(c);
      await sembrarCarga(c, {
        chofer: cargando,
        estado: 'loading',
        llenas: 10,
      });
      const hojaCargando = await hojaConfirmada(cargando, { n: 1 });
      expect(codigo(await iniciar(cargando, hojaCargando.id).expect(409))).toBe(
        'ROUTE_SHEET_TRUCK_LOAD_NOT_READY',
      );

      const corto = await nuevoChofer(c);
      await sembrarCarga(c, { chofer: corto, estado: 'on_route', llenas: 1 });
      const hojaCorta = await hojaConfirmada(corto, { n: 3 });
      const falta = await iniciar(corto, hojaCorta.id).expect(409);
      expect(falta.body).toMatchObject({
        code: 'ROUTE_SHEET_SHORTAGES',
        shortages: [{ required: 3, onTruck: 1, missing: 2 }],
      });
      const sale = await iniciar(corto, hojaCorta.id, {
        acknowledgeShortages: true,
      }).expect(200);
      expect(sale.body).toMatchObject({
        alreadyStarted: false,
        shortages: [{ missing: 2 }],
      });
    });

    it('feliz (Iniciar viaje): con la carga en la calle queda en curso con la carga vinculada y avisa a todos los clientes; el reintento es idempotente', async () => {
      const ch = await choferEnLaCalle();
      const hoja = await hojaConfirmada(ch, { n: 2 });
      // Antes de iniciar, la asignación a mano sigue bloqueada (E3).
      const aMano = await http()
        .patch(`/orders/${hoja.stops[0].orderId}/assign/${ch.deliveryId}`)
        .set(A())
        .expect(409);
      expect(codigo(aMano)).toBe('ORDER_IN_ROUTE_SHEET');

      const r = await iniciar(ch, hoja.id).expect(200);
      expect(r.body).toMatchObject({
        sheetId: hoja.id,
        alreadyStarted: false,
        droppedOrderIds: [],
        shortages: [],
        notifiedCustomers: 2,
      });
      expect(
        (r.body as { assignedOrderIds: string[] }).assignedOrderIds.sort(),
      ).toEqual(hoja.stops.map((s) => s.orderId).sort());
      for (const s of hoja.stops) {
        expect(await pedidoEnBase(s.orderId)).toEqual({
          estado: 'accepted',
          chofer: ch.deliveryId,
        });
      }
      const e = await seguimiento(hoja.id);
      expect(e.status).toBe('assigned');
      expect(e.truckLoadId).not.toBeNull();
      expect(e.nextOrderId).toBe(e.stops[0].orderId);
      expect(e.stops.every((s) => s.etaAt !== null)).toBe(true);

      const otra = await iniciar(ch, hoja.id).expect(200);
      expect(otra.body).toMatchObject({ alreadyStarted: true });

      // Su hoja de hoy la ve el chofer.
      const actual = await http()
        .get(v2('/driver/route-sheets/current'))
        .set(ch.cabeceras)
        .expect(200);
      expect((actual.body as Ejecucion).id).toBe(hoja.id);
    });

    it('dos inicios a la vez: uno inicia, el otro ve la hoja iniciada; cada pedido se asigna una sola vez', async () => {
      const ch = await choferEnLaCalle();
      const hoja = await hojaConfirmada(ch, { n: 3 });
      const [a, b] = await Promise.all([
        iniciar(ch, hoja.id),
        iniciar(ch, hoja.id),
      ]);
      const estados = [a.status, b.status].sort();
      // El segundo espera el cerrojo (200 idempotente) o, si no llega, 409 BUSY.
      expect(estados[0]).toBe(200);
      const cuerpos = [a, b]
        .filter((x) => x.status === 200)
        .map((x) => x.body as { alreadyStarted: boolean });
      expect(cuerpos.filter((x) => !x.alreadyStarted)).toHaveLength(1);
      const noAtendidos = [a, b]
        .filter((x) => x.status !== 200)
        .map((x) => `${x.status} ${codigo(x)}`);
      expect(noAtendidos.every((x) => x === '409 ROUTE_SHEET_BUSY')).toBe(true);
      const historial = await ds.query<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM "order_status_history"
          WHERE "order_id" = ANY($1::uuid[]) AND "to_status"::text = 'accepted'`,
        [hoja.stops.map((s) => s.orderId)],
      );
      expect(historial[0].n).toBe(3);
    });

    it('un pedido cancelado antes de iniciar sale solo de la hoja; si no queda ninguno, 409 NOTHING_TO_START y la hoja sigue confirmada', async () => {
      const ch = await choferEnLaCalle();
      const hoja = await hojaConfirmada(ch, { n: 1 });
      await http()
        .patch(`/orders/${hoja.stops[0].orderId}/cancel`)
        .set(A())
        .send({ reason: 'El cliente se arrepintió' })
        .expect(200);
      expect(codigo(await iniciar(ch, hoja.id).expect(409))).toBe(
        'ROUTE_SHEET_NOTHING_TO_START',
      );
      expect((await seguimiento(hoja.id)).status).toBe('confirmed');
    });

    it('modo soporte: el super admin lee el seguimiento pero no inicia (403)', async () => {
      const ch = await choferEnLaCalle();
      const hoja = await hojaConfirmada(ch, { n: 1 });
      await http()
        .post(v2(`/route-sheets/${hoja.id}/start`))
        .set(c.actores.soporteA)
        .send({})
        .expect(403);
      await http()
        .get(v2(`/route-sheets/${hoja.id}/execution`))
        .set(c.actores.soporteA)
        .expect(200);
      await http()
        .get(v2(`/route-sheets/${hoja.id}/execution`))
        .set(c.actores.super)
        .expect(403);
      await http()
        .get(v2(`/route-sheets/${hoja.id}/execution`))
        .set(c.actores.adminB)
        .expect(404);
    });
  });

  describe('en la calle', () => {
    let ch: ChoferT5;
    let hoja: Hoja;
    let orden: string[];

    beforeAll(async () => {
      ch = await choferEnLaCalle();
      hoja = await hojaConfirmada(ch, { n: 5 });
      await iniciar(ch, hoja.id).expect(200);
      orden = (await seguimiento(hoja.id)).stops.map((s) => s.orderId);
    }, 120000);

    const stop = (orderId: string, accion: string) =>
      v2(`/driver/route-sheets/${hoja.id}/stops/${orderId}/${accion}`);

    it('mi hoja: 401 sin token, 403 admin, 404 de otro chofer, 400 id mal formado, 200 la mía', async () => {
      await http().get(v2('/driver/route-sheets/current')).expect(401);
      await http().get(v2('/driver/route-sheets/current')).set(A()).expect(403);
      await http()
        .get(v2('/driver/route-sheets/no-uuid'))
        .set(ch.cabeceras)
        .expect(400);
      const otro = await nuevoChofer(c);
      await http()
        .get(v2(`/driver/route-sheets/${hoja.id}`))
        .set(otro.cabeceras)
        .expect(404);
      await http()
        .get(v2('/driver/route-sheets/current'))
        .set(otro.cabeceras)
        .expect(204);
      const r = await http()
        .get(v2(`/driver/route-sheets/${hoja.id}`))
        .set(ch.cabeceras)
        .expect(200);
      expect((r.body as Ejecucion).stops).toHaveLength(5);
    });

    it('«en camino» a la siguiente; repetirla es idempotente; otra mientras tanto 409; una que no es de la hoja 404', async () => {
      const r = await http()
        .post(stop(orden[0], 'on-the-way'))
        .set(ch.cabeceras)
        .expect(200);
      expect(r.body).toMatchObject({ orderId: orden[0], detour: false });
      expect((await pedidoEnBase(orden[0])).estado).toBe('on_the_way');
      await http()
        .post(stop(orden[0], 'on-the-way'))
        .set(ch.cabeceras)
        .expect(200);
      expect(
        codigo(
          await http()
            .post(stop(orden[1], 'on-the-way'))
            .set(ch.cabeceras)
            .expect(409),
        ),
      ).toBe('ROUTE_SHEET_STOP_IN_PROGRESS');
      expect(
        codigo(
          await http()
            .post(stop(c.inexistente, 'on-the-way'))
            .set(ch.cabeceras)
            .expect(404),
        ),
      ).toBe('ROUTE_STOP_NOT_FOUND');
      const otro = await nuevoChofer(c);
      await http()
        .post(stop(orden[1], 'on-the-way'))
        .set(otro.cabeceras)
        .expect(404);
    });

    it('«Llegué»: 400 sin coordenadas, 409 si no está en camino, 200 en la puerta y queda anotado', async () => {
      await http()
        .post(stop(orden[0], 'arrived'))
        .set(ch.cabeceras)
        .send({ latitude: 200, longitude: 0 })
        .expect(400);
      const [p] = await ds.query<Array<{ lat: number; lng: number }>>(
        `SELECT ST_Y("deliveryPoint") AS lat, ST_X("deliveryPoint") AS lng FROM "order" WHERE "order_id" = $1`,
        [orden[0]],
      );
      expect(
        codigo(
          await http()
            .post(stop(orden[1], 'arrived'))
            .set(ch.cabeceras)
            .send({ latitude: p.lat, longitude: p.lng })
            .expect(409),
        ),
      ).toBe('ORDER_NOT_ON_THE_WAY');
      const r = await http()
        .post(stop(orden[0], 'arrived'))
        .set(ch.cabeceras)
        .send({ latitude: Number(p.lat), longitude: Number(p.lng) })
        .expect(200);
      expect((r.body as { arrivedAt: string }).arrivedAt).toBeTruthy();
      const e = await seguimiento(hoja.id);
      expect(e.stops.find((s) => s.orderId === orden[0])?.arrivedAt).toBe(
        (r.body as { arrivedAt: string }).arrivedAt,
      );
    });

    it('entregada (la confirma el cliente o el admin): la parada queda entregada y la siguiente pasa a ser la propuesta', async () => {
      await entregarComoAdmin(env, orden[0]);
      const e = await esperar(
        () => seguimiento(hoja.id),
        (x) =>
          x.stops.find((s) => s.orderId === orden[0])?.progress === 'delivered',
      );
      expect(e.progress.delivered).toBe(1);
      expect(e.currentOrderId).toBeNull();
      expect(e.nextOrderId).not.toBe(orden[0]);
    });

    it('desvío: «en camino» a una que no es la siguiente reordena la cola', async () => {
      const antes = await seguimiento(hoja.id);
      const elegida = antes.stops
        .filter((s) => s.progress === 'pending')
        .at(-1)!.orderId;
      const r = await http()
        .post(stop(elegida, 'on-the-way'))
        .set(ch.cabeceras)
        .expect(200);
      expect(r.body).toMatchObject({ detour: true, nextOrderId: elegida });
      const despues = await seguimiento(hoja.id);
      expect(despues.currentOrderId).toBe(elegida);
    });

    it('«No pude entregar»: 400 «other» sin nota; primer intento al final de la cola con el mismo chofer y franja nueva; segundo, se reprograma solo para el día hábil siguiente (salteando un feriado) sin franja fija', async () => {
      const e = await seguimiento(hoja.id);
      const enCamino = e.currentOrderId as string;
      await http()
        .post(stop(enCamino, 'failed'))
        .set(ch.cabeceras)
        .send({ reason: 'other' })
        .expect(400);
      await http()
        .post(stop(enCamino, 'failed'))
        .set(ch.cabeceras)
        .send({ reason: 'se fue' })
        .expect(400);
      const r1 = await http()
        .post(stop(enCamino, 'failed'))
        .set(ch.cabeceras)
        .send({ reason: 'customer_absent', note: 'tocó timbre dos veces' })
        .expect(200);
      expect(r1.body).toMatchObject({
        orderId: enCamino,
        attempt: 1,
        outcome: 'requeued',
      });
      // La ruta se recalculó: la franja nueva («más tarde») va en la respuesta.
      expect(r1.body).toHaveProperty('newWindowStart');
      expect(r1.body).toHaveProperty('newWindowEnd');
      // Sigue siendo del chofer y pasó al final de la cola.
      expect(await pedidoEnBase(enCamino)).toEqual({
        estado: 'accepted',
        chofer: ch.deliveryId,
      });
      const tras1 = await seguimiento(hoja.id);
      const activas = tras1.stops.filter((s) => s.sequence !== null);
      expect(activas[activas.length - 1]).toMatchObject({
        orderId: enCamino,
        progress: 'pending',
        failedAttempts: 1,
        lastFailureNote: 'El cliente no estaba: tocó timbre dos veces',
      });
      // Segundo intento: sale de la hoja y se reprograma solo, salteando un
      // feriado de la distribuidora y sin franja fija.
      const feriado = diaHabilSiguiente(hoy);
      const alta = await http()
        .post(v2('/route-planning/holidays'))
        .set(A())
        .send({ date: feriado, description: 'Feriado de prueba' })
        .expect(201);
      await http()
        .post(stop(enCamino, 'on-the-way'))
        .set(ch.cabeceras)
        .expect(200);
      const r2 = await http()
        .post(stop(enCamino, 'failed'))
        .set(ch.cabeceras)
        .send({ reason: 'customer_absent' })
        .expect(200);
      const esperado = diaHabilSiguiente(feriado);
      await http()
        .delete(
          v2(
            `/route-planning/holidays/${(alta.body as { holidayId: string }).holidayId}`,
          ),
        )
        .set(A())
        .expect(204);
      expect(r2.body).toMatchObject({
        attempt: 2,
        outcome: 'rescheduled',
        rescheduledTo: esperado,
      });
      const [p] = await ds.query<
        Array<{
          estado: string;
          chofer: string | null;
          fecha: string;
          franja: string | null;
        }>
      >(
        `SELECT "status"::text AS estado, "delivery_id" AS chofer, to_char("scheduled_date", 'YYYY-MM-DD') AS fecha,
                "time_slot_id" AS franja
           FROM "order" WHERE "order_id" = $1`,
        [enCamino],
      );
      expect(p).toEqual({
        estado: 'pending',
        chofer: null,
        fecha: esperado,
        franja: null,
      });
      const tras2 = await seguimiento(hoja.id);
      expect(tras2.stops.find((s) => s.orderId === enCamino)).toMatchObject({
        progress: 'failed',
        removedReason: 'rescheduled',
        failedAttempts: 2,
        sequence: null,
        rescheduledTo: esperado,
        awaitingAdmin: false,
      });
      expect(
        codigo(
          await http()
            .post(stop(enCamino, 'failed'))
            .set(ch.cabeceras)
            .send({ reason: 'rejected' })
            .expect(404),
        ),
      ).toBe('ROUTE_STOP_NOT_FOUND');
    });

    it('el panel cancela un pedido de la hoja: la parada sale sola (cancelled) y la cola se reordena', async () => {
      const e = await seguimiento(hoja.id);
      const victima = e.stops.find((s) => s.progress === 'pending')!.orderId;
      await http()
        .patch(`/orders/${victima}/cancel`)
        .set(A())
        .send({ reason: 'Pidió cancelar' })
        .expect(200);
      const despues = await esperar(
        () => seguimiento(hoja.id),
        (x) =>
          x.stops.find((s) => s.orderId === victima)?.removedReason ===
          'cancelled',
      );
      expect(despues.stops.find((s) => s.orderId === victima)?.progress).toBe(
        'removed',
      );
    });

    it('el panel agrega y saca paradas en curso (con versión); otra distribuidora 404; versión vieja 409', async () => {
      const antes = await seguimiento(hoja.id);
      const nuevo = await pedidoPara(hoy);
      await http()
        .post(v2(`/route-sheets/${hoja.id}/stops`))
        .set(c.actores.adminB)
        .send({ version: antes.version, orderId: nuevo })
        .expect(404);
      expect(
        codigo(
          await http()
            .post(v2(`/route-sheets/${hoja.id}/stops`))
            .set(A())
            .send({ version: antes.version + 7, orderId: nuevo })
            .expect(409),
        ),
      ).toBe('ROUTE_SHEET_VERSION_CONFLICT');
      const r = await http()
        .post(v2(`/route-sheets/${hoja.id}/stops`))
        .set(A())
        .send({ version: antes.version, orderId: nuevo, position: 1 })
        .expect(200);
      expect(await pedidoEnBase(nuevo)).toEqual({
        estado: 'accepted',
        chofer: ch.deliveryId,
      });
      const conNuevo = await seguimiento(hoja.id);
      expect(conNuevo.nextOrderId).toBe(nuevo);
      const version = (r.body as Hoja).version;
      await http()
        .delete(v2(`/route-sheets/${hoja.id}/stops/${nuevo}`))
        .set(A())
        .send({ version })
        .expect(200);
      expect(await pedidoEnBase(nuevo)).toEqual({
        estado: 'pending',
        chofer: null,
      });
      expect(
        (await seguimiento(hoja.id)).stops.find((s) => s.orderId === nuevo)
          ?.removedReason,
      ).toBe('admin');
    });

    it('el panel reasigna un pedido de la hoja a otro chofer: la parada sale (reassigned)', async () => {
      const otro = await choferEnLaCalle();
      const e = await seguimiento(hoja.id);
      const pendiente = e.stops.find((s) => s.progress === 'pending')!.orderId;
      await http()
        .patch(`/orders/${pendiente}/assign/${otro.deliveryId}`)
        .set(A())
        .expect(200);
      const despues = await esperar(
        () => seguimiento(hoja.id),
        (x) =>
          x.stops.find((s) => s.orderId === pendiente)?.removedReason ===
          'reassigned',
      );
      expect(despues.stops.find((s) => s.orderId === pendiente)?.progress).toBe(
        'removed',
      );
    });

    it('cerrar a mano: 400 sin motivo; 200 saca lo pendiente y lo reprograma solo; repetir es idempotente; una confirmada sin iniciar 409', async () => {
      await http()
        .post(v2(`/driver/route-sheets/${hoja.id}/close`))
        .set(ch.cabeceras)
        .send({})
        .expect(400);
      const r = await http()
        .post(v2(`/driver/route-sheets/${hoja.id}/close`))
        .set(ch.cabeceras)
        .send({ reason: 'Se pinchó una goma' })
        .expect(200);
      const cuerpo = r.body as {
        releasedOrderIds: string[];
        rescheduled: Array<{ orderId: string; scheduledDate: string | null }>;
      };
      expect(cuerpo.releasedOrderIds.length).toBeGreaterThan(0);
      // Lo pendiente no vuelve al despacho común: se reprograma solo.
      for (const { orderId, scheduledDate } of cuerpo.rescheduled) {
        expect(scheduledDate).toBe(diaHabilSiguiente(hoy));
        expect(await pedidoEnBase(orderId)).toEqual({
          estado: 'pending',
          chofer: null,
        });
      }
      const e = await seguimiento(hoja.id);
      expect(e.status).toBe('completed');
      expect(e.closeNote).toBe('Se pinchó una goma');
      const otra = await http()
        .post(v2(`/route-sheets/${hoja.id}/close`))
        .set(A())
        .send({ reason: 'De nuevo' })
        .expect(200);
      expect(otra.body).toMatchObject({ alreadyClosed: true });
      const sinIniciar = await hojaConfirmada(await nuevoChofer(c), { n: 1 });
      expect(
        codigo(
          await http()
            .post(v2(`/route-sheets/${sinIniciar.id}/close`))
            .set(A())
            .send({ reason: 'No salió' })
            .expect(409),
        ),
      ).toBe('ROUTE_SHEET_NOT_IN_PROGRESS');
      // Las paradas de una hoja cerrada ya no se operan.
      expect(
        codigo(
          await http()
            .post(stop(orden[1], 'on-the-way'))
            .set(ch.cabeceras)
            .expect(409),
        ),
      ).toBe('ROUTE_SHEET_NOT_IN_PROGRESS');
    });
  });

  it('la hoja se cierra sola al entregar la última parada', async () => {
    const ch = await choferEnLaCalle();
    const hoja = await hojaConfirmada(ch, { n: 1 });
    await iniciar(ch, hoja.id).expect(200);
    const [unico] = hoja.stops;
    await http()
      .post(
        v2(`/driver/route-sheets/${hoja.id}/stops/${unico.orderId}/on-the-way`),
      )
      .set(ch.cabeceras)
      .expect(200);
    await entregarComoAdmin(env, unico.orderId);
    const e = await esperar(
      () => seguimiento(hoja.id),
      (x) => x.status === 'completed',
    );
    expect(e.status).toBe('completed');
    expect(e.closeNote).toBeNull();
    expect(e.stops[0].progress).toBe('delivered');
  });

  describe('hora estimada del cliente (GET /v2/orders/:id/eta)', () => {
    it('401 sin token, 403 otro rol, 400 id mal formado, 404 de otro cliente, 204 sin hoja, 200 en una hoja', async () => {
      const ch = await choferEnLaCalle();
      const hoja = await hojaConfirmada(ch, { n: 1 });
      const pedido = hoja.stops[0].orderId;
      await http()
        .get(v2(`/orders/${pedido}/eta`))
        .expect(401);
      await http()
        .get(v2(`/orders/${pedido}/eta`))
        .set(A())
        .expect(403);
      await http()
        .get(v2('/orders/no-uuid/eta'))
        .set(c.actores.clienteA)
        .expect(400);
      await http()
        .get(v2(`/orders/${pedido}/eta`))
        .set(c.actores.clienteB)
        .expect(404);
      const suelto = await sembrarPedido(c);
      await http()
        .get(v2(`/orders/${suelto}/eta`))
        .set(c.actores.clienteA)
        .expect(204);
      const r = await http()
        .get(v2(`/orders/${pedido}/eta`))
        .set(c.actores.clienteA)
        .expect(200);
      expect(r.body).toMatchObject({
        orderId: pedido,
        source: 'route_sheet',
        inProgress: false,
      });
      await iniciar(ch, hoja.id).expect(200);
      const enCurso = await http()
        .get(v2(`/orders/${pedido}/eta`))
        .set(c.actores.clienteA)
        .expect(200);
      expect(enCurso.body).toMatchObject({ inProgress: true });
      const cuerpo = enCurso.body as {
        windowStart: string;
        windowEnd: string;
        etaAt: string;
      };
      expect(Date.parse(cuerpo.windowStart)).toBeLessThanOrEqual(
        Date.parse(cuerpo.windowEnd),
      );
    });
  });

  describe('feriados de la hoja de ruta (/v2/route-planning/holidays, migración 039)', () => {
    const ruta = v2('/route-planning/holidays');
    const fecha = (dias: number) => {
      const d = new Date(`${hoy}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + dias);
      return d.toISOString().slice(0, 10);
    };

    it('acceso: 401 sin token, 403 cliente o chofer, 400 cuerpo o id inválidos', async () => {
      await http().get(ruta).expect(401);
      await http().get(ruta).set(c.actores.clienteA).expect(403);
      const ch = await nuevoChofer(c);
      await http().post(ruta).set(ch.cabeceras).send({}).expect(403);
      await http()
        .post(ruta)
        .set(A())
        .send({ date: '2026-02-30', description: 'x' })
        .expect(400);
      await http()
        .post(ruta)
        .set(A())
        .send({ date: fecha(40), description: ' ' })
        .expect(400);
      await http().get(`${ruta}?from=01-11-2026`).set(A()).expect(400);
      await http().delete(`${ruta}/no-es-uuid`).set(A()).expect(400);
    });

    it('alta, listado, 409 repetido o pasado, baja lógica (204), otra distribuidora 404 y se puede volver a cargar', async () => {
      const dia = fecha(45);
      const alta = await http()
        .post(ruta)
        .set(A())
        .send({ date: dia, description: 'Inmaculada Concepción' })
        .expect(201);
      const id = (alta.body as { holidayId: string }).holidayId;
      expect(alta.body).toMatchObject({
        date: dia,
        description: 'Inmaculada Concepción',
      });
      expect(
        codigo(
          await http()
            .post(ruta)
            .set(A())
            .send({ date: dia, description: 'Otra vez' })
            .expect(409),
        ),
      ).toBe('ROUTE_HOLIDAY_ALREADY_EXISTS');
      expect(
        codigo(
          await http()
            .post(ruta)
            .set(A())
            .send({ date: fecha(-1), description: 'Ayer' })
            .expect(409),
        ),
      ).toBe('ROUTE_HOLIDAY_DATE_PAST');
      const lista = await http()
        .get(`${ruta}?from=${dia}&to=${dia}`)
        .set(A())
        .expect(200);
      expect(lista.body).toEqual([expect.objectContaining({ holidayId: id })]);
      // La otra distribuidora no lo ve ni lo borra (y puede cargar el mismo día).
      const deB = await http()
        .get(`${ruta}?from=${dia}&to=${dia}`)
        .set(c.actores.adminB)
        .expect(200);
      expect(deB.body).toEqual([]);
      expect(
        codigo(
          await http()
            .delete(`${ruta}/${id}`)
            .set(c.actores.adminB)
            .expect(404),
        ),
      ).toBe('ROUTE_HOLIDAY_NOT_FOUND');
      await http()
        .post(ruta)
        .set(c.actores.adminB)
        .send({ date: dia, description: 'De la B' })
        .expect(201);
      await http().delete(`${ruta}/${id}`).set(A()).expect(204);
      expect(
        codigo(await http().delete(`${ruta}/${id}`).set(A()).expect(404)),
      ).toBe('ROUTE_HOLIDAY_NOT_FOUND');
      const [fila] = await ds.query<Array<{ borrado: boolean }>>(
        `SELECT "deletedAt" IS NOT NULL AS borrado FROM "route_planning_holiday" WHERE "holiday_id" = $1`,
        [id],
      );
      expect(fila.borrado).toBe(true);
      // Dado de baja, el día se puede volver a cargar (único sólo entre vigentes).
      await http()
        .post(ruta)
        .set(A())
        .send({ date: dia, description: 'Inmaculada Concepción' })
        .expect(201);
      await expect(
        ds.query(
          `INSERT INTO "route_planning_holiday" ("distributor_id", "holiday_date", "description") VALUES ($1, $2, 'Duplicado')`,
          [c.distA.id, dia],
        ),
      ).rejects.toThrow(/UQ_route_planning_holiday_vigente/);
      await expect(
        ds.query(
          `INSERT INTO "route_planning_holiday" ("distributor_id", "holiday_date", "description") VALUES ($1, $2, ' ')`,
          [c.distA.id, fecha(50)],
        ),
      ).rejects.toThrow(/CHK_route_planning_holiday_descripcion/);
    });

    it('modo soporte: el super admin lee los feriados pero no los carga (403)', async () => {
      await http().get(ruta).set(c.actores.soporteA).expect(200);
      await http()
        .post(ruta)
        .set(c.actores.soporteA)
        .send({ date: fecha(60), description: 'Soporte' })
        .expect(403);
    });
  });

  describe('reglas en la base (migración 037)', () => {
    it('una nota de salida sin motivo, o una nota de cierre en una hoja sin cerrar, no entran', async () => {
      const ch = await nuevoChofer(c);
      const hoja = await hojaConfirmada(ch, { n: 1 });
      await expect(
        ds.query(
          `UPDATE "route_batch_stop" SET "removed_note" = 'x' WHERE "batch_id" = $1`,
          [hoja.id],
        ),
      ).rejects.toThrow(/CHK_route_batch_stop_nota/);
      await expect(
        ds.query(
          `UPDATE "route_batch" SET "close_note" = 'x' WHERE "batch_id" = $1`,
          [hoja.id],
        ),
      ).rejects.toThrow(/CHK_route_batch_nota_cierre/);
      await expect(
        ds.query(
          `UPDATE "route_batch_stop" SET "failed_attempts" = 3, "last_failed_at" = now() WHERE "batch_id" = $1`,
          [hoja.id],
        ),
      ).rejects.toThrow(/CHK_route_batch_stop_intentos/);
      await expect(
        ds.query(
          `UPDATE "route_batch_stop" SET "failed_attempts" = 1 WHERE "batch_id" = $1`,
          [hoja.id],
        ),
      ).rejects.toThrow(/CHK_route_batch_stop_intentos/);
    });

    it('el CHECK de los parámetros rechaza arrivalWaitMinutes fuera de 1–60 (y la API también)', async () => {
      await http()
        .patch(v2('/route-planning/settings'))
        .set(A())
        .send({ arrivalWaitMinutes: 61 })
        .expect(400);
      await expect(
        ds.query(
          `UPDATE "module_config" SET "params" = "params" || '{"arrivalWaitMinutes": 0}'::jsonb
            WHERE "distributor_id" = $1 AND "module"::text = 'route_planning'`,
          [c.distA.id],
        ),
      ).rejects.toThrow(/CHK_module_config_hoja_de_ruta/);
      const r = await http()
        .patch(v2('/route-planning/settings'))
        .set(A())
        .send({ arrivalWaitMinutes: 12 })
        .expect(200);
      expect(
        (r.body as { params: Record<string, number> }).params
          .arrivalWaitMinutes,
      ).toBe(12);
    });

    it('el CHECK de los parámetros rechaza workingDays fuera de 1–127 (y la API también)', async () => {
      for (const v of [0, 128]) {
        await http()
          .patch(v2('/route-planning/settings'))
          .set(A())
          .send({ workingDays: v })
          .expect(400);
      }
      await expect(
        ds.query(
          `UPDATE "module_config" SET "params" = "params" || '{"workingDays": 200}'::jsonb
            WHERE "distributor_id" = $1 AND "module"::text = 'route_planning'`,
          [c.distA.id],
        ),
      ).rejects.toThrow(/CHK_module_config_hoja_de_ruta/);
      const r = await http()
        .patch(v2('/route-planning/settings'))
        .set(A())
        .send({ workingDays: 63 })
        .expect(200);
      expect(
        (r.body as { params: Record<string, number> }).params.workingDays,
      ).toBe(63);
    });

    it('el trigger del pedido admite en camino → aceptado (la parada vuelve a la cola) y sigue rechazando una transición inválida', async () => {
      const ch = await choferEnLaCalle();
      const hoja = await hojaConfirmada(ch, { n: 1 });
      const pedido = hoja.stops[0].orderId;
      await ds.query(
        `UPDATE "order" SET "status" = 'on_the_way', "onTheWayAt" = now() WHERE "order_id" = $1`,
        [pedido],
      );
      await ds.query(
        `UPDATE "order" SET "status" = 'accepted' WHERE "order_id" = $1`,
        [pedido],
      );
      expect((await pedidoEnBase(pedido)).estado).toBe('accepted');
      await expect(
        ds.query(
          `UPDATE "order" SET "status" = 'reserved' WHERE "order_id" = $1`,
          [pedido],
        ),
      ).rejects.toThrow(/CHK_order_transicion_de_estado/);
    });
  });
});
