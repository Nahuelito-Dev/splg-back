/**
 * Ubicación del depósito (v2) contra la app con Postgres y Redis efímeros:
 * - la matriz HTTP del alta, la edición y las lecturas v2 de `/warehouses`
 *   (201/200, 400 por cada regla, 401, 403, 404 de otra distribuidora, 409);
 * - la v1 sigue igual (no acepta ni devuelve la ubicación);
 * - el CHECK `CHK_warehouse_ubicacion` frena lo que se escapa del back;
 * - una hoja de ruta que sale de un depósito ubicado ya no avisa `no_warehouse`.
 *
 * La matriz de tiempos de la hoja es la de línea recta (sin OSRM): determinista.
 */
import request from 'supertest';
import { DataSource } from 'typeorm';
import { diaArgentino } from '../../src/common/utils/dias-argentina';
import { Order } from '../../src/order/entities/order.entity';
import { TimeSlot } from '../../src/time-slot/entities/time-slot.entity';
import { diaSiguiente } from '../../src/route-batch/domain/route-sheet-rules';
import { haversineMatrix } from '../../src/routes/route-matrix';
import { RouteMatrixPort } from '../../src/routes/route-matrix.port';
import { PuntoDeRuta } from '../../src/routes/polyline';
import { conBypassManager } from './setup/bypass';
import { createTestApp, TestEnv } from './setup/test-env';
import { Caso, correrMatriz, endpoint } from './matriz-http/matriz';
import { casosEnModoSoporte } from './matriz-http/soporte';
import { sembrarPedido, unico, ZONA_CENTRO } from './matriz-http/t2-base';
import { EscenarioT5, nuevoChofer, sembrarBaseT5 } from './matriz-http/t5-base';

type C = EscenarioT5;
const ADMIN = 'adminA';
const POSADAS = { latitude: -27.3671, longitude: -55.8961 };

interface DepositoV2 {
  warehouseId: string;
  latitude: number | null;
  longitude: number | null;
}

const conUbicacion =
  (latitude: number | null, longitude: number | null) => (cuerpo: unknown) => {
    expect(cuerpo).toMatchObject({ latitude, longitude });
  };

const alta = endpoint<C>('post', '/v2/warehouses', '/v2/warehouses');
const altaV1 = endpoint<C>('post', '/v1/warehouses', '/v1/warehouses');
const edicion = endpoint<C>(
  'patch',
  '/v2/warehouses/{id}',
  (c) => `/v2/warehouses/${c.depositoA}`,
);
const lista = endpoint<C>('get', '/v2/warehouses', '/v2/warehouses');
const detalle = endpoint<C>(
  'get',
  '/v2/warehouses/{id}',
  (c) => `/v2/warehouses/${c.depositoA}`,
);
const nuevo = () => ({
  name: `Galpón ${unico()}`,
  code: unico().toUpperCase(),
});

const casos: Array<Caso<C>> = [
  // Alta
  alta('crea con la ubicación de Posadas', ADMIN, 201, {
    body: () => ({ ...nuevo(), ...POSADAS }),
    verificar: conUbicacion(POSADAS.latitude, POSADAS.longitude),
  }),
  alta('crea sin ubicación', ADMIN, 201, {
    body: () => nuevo(),
    verificar: conUbicacion(null, null),
  }),
  alta('las dos en null (borrar es de la edición)', ADMIN, 400, {
    body: () => ({ ...nuevo(), latitude: null, longitude: null }),
    mensaje: 'Latitud del depósito: no puede ir vacía',
  }),
  alta('sólo la latitud en null', ADMIN, 400, {
    body: () => ({ ...nuevo(), latitude: null }),
    mensaje: 'Latitud del depósito: va junto con la longitud',
  }),
  alta('sólo la latitud', ADMIN, 400, {
    body: () => ({ ...nuevo(), latitude: POSADAS.latitude }),
    mensaje: 'Longitud del depósito: va junto con la latitud',
  }),
  alta('sólo la longitud', ADMIN, 400, {
    body: () => ({ ...nuevo(), longitude: POSADAS.longitude }),
    mensaje: 'Latitud del depósito: va junto con la longitud',
  }),
  alta('latitud fuera de rango', ADMIN, 400, {
    body: () => ({ ...nuevo(), latitude: 91, longitude: POSADAS.longitude }),
    mensaje: 'Latitud del depósito',
  }),
  alta('longitud fuera de rango', ADMIN, 400, {
    body: () => ({ ...nuevo(), latitude: POSADAS.latitude, longitude: -181 }),
    mensaje: 'Longitud del depósito',
  }),
  alta('coordenada como texto', ADMIN, 400, {
    body: () => ({ ...nuevo(), latitude: '-27.3', longitude: -55.8 }),
    mensaje: 'Latitud del depósito',
  }),
  alta('rol sin permiso', 'clienteA', 403, {
    body: () => ({ ...nuevo(), ...POSADAS }),
  }),
  alta('sin token', undefined, 401, {
    body: () => ({ ...nuevo(), ...POSADAS }),
  }),
  alta('código repetido', ADMIN, 409, {
    body: () => ({ name: 'Otro', code: 'CENTRAL', ...POSADAS }),
  }),
  altaV1('la v1 no acepta la ubicación', ADMIN, 400, {
    body: () => ({ ...nuevo(), ...POSADAS }),
    mensaje: 'Se envió un dato que no corresponde',
  }),
  altaV1('la v1 no devuelve la ubicación', ADMIN, 201, {
    body: () => nuevo(),
    verificar: (cuerpo) => {
      expect(cuerpo).not.toHaveProperty('latitude');
      expect(cuerpo).not.toHaveProperty('longitude');
    },
  }),

  // Edición
  edicion('fija la ubicación', ADMIN, 200, {
    body: POSADAS,
    verificar: conUbicacion(POSADAS.latitude, POSADAS.longitude),
  }),
  edicion('sin coordenadas no toca la ubicación', ADMIN, 200, {
    antes: async (c) => {
      await request(c.app.getHttpServer())
        .patch(`/v2/warehouses/${c.depositoA}`)
        .set(c.actores[ADMIN])
        .send(POSADAS)
        .expect(200);
    },
    body: { address: 'Av. Uruguay 1234, Posadas' },
    verificar: conUbicacion(POSADAS.latitude, POSADAS.longitude),
  }),
  edicion('las dos en null la borran', ADMIN, 200, {
    body: { latitude: null, longitude: null },
    verificar: conUbicacion(null, null),
  }),
  edicion('sólo la latitud, en null', ADMIN, 400, {
    body: { latitude: null },
    mensaje: 'Latitud del depósito: va junto con la longitud',
  }),
  edicion('sólo la longitud, en null', ADMIN, 400, {
    body: { longitude: null },
    mensaje: 'Longitud del depósito: va junto con la latitud',
  }),
  edicion('sólo una en null', ADMIN, 400, {
    body: { latitude: POSADAS.latitude, longitude: null },
    mensaje: 'Longitud del depósito: va junto con la latitud',
  }),
  edicion('latitud fuera de rango', ADMIN, 400, {
    body: { latitude: -90.5, longitude: POSADAS.longitude },
    mensaje: 'Latitud del depósito',
  }),
  edicion('longitud fuera de rango', ADMIN, 400, {
    body: { latitude: POSADAS.latitude, longitude: 180.5 },
    mensaje: 'Longitud del depósito',
  }),
  edicion('id inválido', ADMIN, 400, {
    ruta: '/v2/warehouses/no',
    body: POSADAS,
    mensajeExacto: 'El identificador no es válido',
  }),
  edicion('rol sin permiso', 'clienteA', 403, { body: POSADAS }),
  edicion('sin token', undefined, 401, { body: POSADAS }),
  edicion('inexistente', ADMIN, 404, {
    ruta: (c) => `/v2/warehouses/${c.inexistente}`,
    body: POSADAS,
  }),
  edicion('de otra distribuidora', ADMIN, 404, {
    ruta: (c) => `/v2/warehouses/${c.depositoB}`,
    body: POSADAS,
  }),
  {
    endpoint: 'PATCH /v1/warehouses/{id}',
    caso: 'la v1 no acepta la ubicación',
    metodo: 'patch',
    ruta: (c) => `/v1/warehouses/${c.depositoA}`,
    actor: ADMIN,
    body: POSADAS,
    esperado: 400,
    mensaje: 'Se envió un dato que no corresponde',
  },

  // Lecturas v2
  lista('lista con la ubicación', ADMIN, 200, {
    verificar: (cuerpo) => {
      const filas = cuerpo as DepositoV2[];
      expect(filas.length).toBeGreaterThan(0);
      for (const f of filas) {
        expect(f).toHaveProperty('latitude');
        expect(f).toHaveProperty('longitude');
      }
    },
  }),
  lista('rol sin permiso', 'clienteA', 403),
  lista('sin token', undefined, 401),
  detalle('ve el depósito con su ubicación', ADMIN, 200, {
    verificar: (cuerpo) => {
      expect(cuerpo).toHaveProperty('latitude');
      expect(cuerpo).toHaveProperty('balances');
    },
  }),
  detalle('id inválido', ADMIN, 400, { ruta: '/v2/warehouses/no' }),
  detalle('de otra distribuidora', ADMIN, 404, {
    ruta: (c) => `/v2/warehouses/${c.depositoB}`,
  }),
  detalle('rol sin permiso', 'clienteA', 403),
  detalle('sin token', undefined, 401),

  // Super admin: sin sesión de soporte no entra; con sesión lee y no escribe.
  ...casosEnModoSoporte(lista, alta, {
    escritura: { body: () => ({ ...nuevo(), ...POSADAS }) },
  }),
  ...casosEnModoSoporte(detalle, edicion, { escritura: { body: POSADAS } }),
  detalle('super admin en modo soporte: lo de otra empresa', 'soporteA', 404, {
    ruta: (c) => `/v2/warehouses/${c.depositoB}`,
  }),
];

describe('Depósitos con ubicación (e2e)', () => {
  let env: TestEnv;
  let c: C;
  let ds: DataSource;

  const http = () => request(env.app.getHttpServer());
  const A = () => c.actores.adminA;

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
  }, 300000);

  afterAll(async () => {
    await env?.cleanup();
  });

  correrMatriz('Matriz HTTP · depósitos v2', () => c, casos);

  describe('la base', () => {
    it.each([
      ['latitud', 'ST_SetSRID(ST_MakePoint(-55.8961, -91), 4326)'],
      ['longitud', 'ST_SetSRID(ST_MakePoint(-181, -27.3671), 4326)'],
    ])(
      'CHK_warehouse_ubicacion rechaza una %s fuera de rango',
      async (_campo, punto) => {
        await expect(
          ds.query(
            `UPDATE "warehouse" SET "location" = ${punto} WHERE "warehouse_id" = $1`,
            [c.depositoA],
          ),
        ).rejects.toThrow(/CHK_warehouse_ubicacion/);
      },
    );

    it('acepta un punto en rango y la lectura v2 lo devuelve', async () => {
      await ds.query(
        `UPDATE "warehouse" SET "location" = ST_SetSRID(ST_MakePoint(-55.8961, -27.3671), 4326) WHERE "warehouse_id" = $1`,
        [c.depositoA],
      );
      const r = await http()
        .get(`/v2/warehouses/${c.depositoA}`)
        .set(A())
        .expect(200);
      expect(r.body).toMatchObject(POSADAS);
    });
  });

  describe('hoja de ruta', () => {
    let manana: string;

    interface Hoja {
      id: string;
      originWarehouseId: string | null;
      warnings: Array<{ code: string }>;
    }

    const hojasDelDia = async (): Promise<Hoja[]> => {
      const dia = (
        await http().get(`/v2/route-plans/${manana}`).set(A()).expect(200)
      ).body as { sheets: Array<{ id: string }> };
      const hojas: Hoja[] = [];
      for (const s of dia.sheets) {
        hojas.push(
          (await http().get(`/v2/route-sheets/${s.id}`).set(A()).expect(200))
            .body as Hoja,
        );
      }
      return hojas;
    };

    beforeAll(async () => {
      manana = diaSiguiente(diaArgentino());
      const franja = await ds.getRepository(TimeSlot).save({
        distributorId: c.distA.id,
        name: 'Todo el día',
        startTime: '06:00',
        endTime: '22:00',
        capacity: 100,
        isActive: true,
      } as Partial<TimeSlot>);
      await nuevoChofer(c);
      for (let i = 0; i < 2; i++) {
        const orderId = await sembrarPedido(c);
        await conBypassManager(ds, ['transiciones', 'reglas'], async (m) => {
          await m.query(
            `DELETE FROM "order_dispatch_offer" WHERE "order_id" = $1`,
            [orderId],
          );
          await m.update(Order, { orderId }, {
            scheduledDate: manana,
            timeSlotId: franja.timeSlotId,
          } as Partial<Order>);
          await m.query(
            `UPDATE "order" SET "createdAt" = ($2::date - 2)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires' WHERE "order_id" = $1`,
            [orderId, manana],
          );
        });
      }
      await http()
        .patch('/v2/route-planning/settings')
        .set(A())
        .send({ enabled: 1 })
        .expect(200);
      await http().post(`/v2/route-plans/${manana}/open`).set(A()).expect(200);
    }, 120000);

    it('sin depósitos ubicados, la hoja avisa no_warehouse', async () => {
      // La propuesta sale del depósito pedido o, si no, del predeterminado o
      // de cualquier otro ubicado: se borra la ubicación de todos (la matriz
      // creó galpones ubicados en esta distribuidora).
      const depositos = (
        await http()
          .get('/v2/warehouses?includeInactive=true')
          .set(A())
          .expect(200)
      ).body as DepositoV2[];
      for (const d of depositos.filter((x) => x.latitude !== null)) {
        await http()
          .patch(`/v2/warehouses/${d.warehouseId}`)
          .set(A())
          .send({ latitude: null, longitude: null })
          .expect(200);
      }
      await http()
        .post(`/v2/route-plans/${manana}/propose`)
        .set(A())
        .send({})
        .expect(200);
      const hojas = await hojasDelDia();
      expect(hojas).toHaveLength(1);
      for (const h of hojas) {
        expect(h.originWarehouseId).toBeNull();
        expect(h.warnings.map((w) => w.code)).toContain('no_warehouse');
      }
    });

    it('con el depósito ubicado por la API, la hoja sale de él y ya no avisa no_warehouse', async () => {
      // Al lado de los pedidos de prueba (Buenos Aires): un depósito lejano
      // deja las paradas fuera de franja y la propuesta no arma la hoja.
      await http()
        .patch(`/v2/warehouses/${c.depositoA}`)
        .set(A())
        .send({
          latitude: ZONA_CENTRO.lat + 0.01,
          longitude: ZONA_CENTRO.lng + 0.01,
        })
        .expect(200);
      // Re-proponer rehace los borradores del sistema sin ediciones.
      await http()
        .post(`/v2/route-plans/${manana}/propose`)
        .set(A())
        .send({})
        .expect(200);
      const hojas = await hojasDelDia();
      expect(hojas).toHaveLength(1);
      for (const h of hojas) {
        expect(h.originWarehouseId).toBe(c.depositoA);
        expect(h.warnings.map((w) => w.code)).not.toContain('no_warehouse');
      }
    });
  });
});
