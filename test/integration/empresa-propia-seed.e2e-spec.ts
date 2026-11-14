/**
 * La siembra de la empresa propia de la plataforma (`npm run seed:empresa-propia`)
 * contra una base efímera: copia lo de la demo, deja el galpón en Posadas,
 * las cuentas de prueba y la marca, y es idempotente (la segunda corrida no
 * crea nada ni vuelve a llamar a Firebase). Al final, el super admin la opera
 * directo con `X-Distributor`.
 */
import { randomUUID } from 'crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import request from 'supertest';
import { DataSource } from 'typeorm';
import type { auth } from 'firebase-admin';
import { CustomersService } from '../../src/customer/customer.service';
import { FirebaseAuthPort } from '../../src/firebase/ports/firebase-auth.port';
import { RegistroService } from '../../src/registro/registro.service';
import {
  CHOFERES_DE_PRUEBA,
  CLIENTES_DE_PRUEBA,
  EMPRESA_PROPIA,
  GALPON_POSADAS,
  sembrarEmpresaPropia,
} from '../../scripts/lib/empresa-propia';
import { TestEnv, createTestApp, telefonoDePrueba } from './setup/test-env';
import { cabecerasDe_, sembrarEscenario } from './matriz-http/matriz';
import type { Escenario } from './matriz-http/matriz';

describe('Siembra de la empresa propia de la plataforma (e2e)', () => {
  let env: TestEnv;
  let e: Escenario;
  let crearEnFirebase: jest.SpyInstance;
  const ds = () => env.app.get(DataSource);
  const deps = () => ({
    ds: ds(),
    eventos: env.app.get(EventEmitter2),
    registro: env.app.get(RegistroService),
    clientes: env.app.get(CustomersService),
  });

  beforeAll(async () => {
    process.env.THROTTLE_LIMIT = '100000';
    env = await createTestApp();
    e = await sembrarEscenario(env.app);
    crearEnFirebase = jest
      .spyOn(env.app.get(FirebaseAuthPort), 'createUser')
      .mockImplementation((p: auth.CreateRequest) =>
        Promise.resolve({ uid: `uid-${p.email}` } as auth.UserRecord),
      );

    // La «demo» de la que se copia: catálogo con promoción, una franja, dos
    // zonas en Posadas y dos vehículos activos (más uno dado de baja).
    const [demo] = await ds().query<Array<{ distributor_id: string }>>(
      `INSERT INTO distributor (name, slug) VALUES ('Demo', 'demo') RETURNING distributor_id`,
    );
    const d = demo.distributor_id;
    const [g] = await ds().query<Array<{ gas_cylinder_id: string }>>(
      `INSERT INTO gas_cylinder (distributor_id, type, weight, price, container_price, stock, description, "isActive")
       VALUES ($1, 'Garrafa 10 kg', 10, 12000, 30000, 40, 'La chica', true),
              ($1, 'Garrafa 15 kg', 15, 17000, 40000, 25, 'La mediana', true)
       RETURNING gas_cylinder_id`,
      [d],
    );
    await ds().query(
      `INSERT INTO gas_cylinder_promotion (gas_cylinder_id, quantity, discount_percentage) VALUES ($1, 3, 10)`,
      [g.gas_cylinder_id],
    );
    await ds().query(
      `INSERT INTO time_slot (distributor_id, name, "startTime", "endTime", capacity, "isActive")
       VALUES ($1, 'Mañana', '08:00', '12:00', 20, true)`,
      [d],
    );
    const poligono = (lat: number, lng: number) =>
      JSON.stringify({
        type: 'Polygon',
        coordinates: [
          [
            [lng, lat],
            [lng + 0.02, lat],
            [lng + 0.02, lat + 0.02],
            [lng, lat + 0.02],
            [lng, lat],
          ],
        ],
      });
    await ds().query(
      `INSERT INTO coverage_zone (distributor_id, name, area, surcharge_type, surcharge_value, "isActive", priority)
       VALUES ($1, 'Centro', ST_SetSRID(ST_GeomFromGeoJSON($2), 4326), 'fixed', 0, true, 1),
              ($1, 'Villa Sarita', ST_SetSRID(ST_GeomFromGeoJSON($3), 4326), 'fixed', 500, true, 2)`,
      [d, poligono(-27.38, -55.91), poligono(-27.4, -55.89)],
    );
    const [dueño] = await ds().query<Array<{ user_id: string }>>(
      `INSERT INTO "user" (full_name, email, phone_number) VALUES ('Chofer Demo', $1, $2) RETURNING user_id`,
      [
        `chofer.demo.${randomUUID().slice(0, 6)}@splg.local`,
        telefonoDePrueba(),
      ],
    );
    await ds().query(
      `INSERT INTO car (distributor_id, user_id, type_car, car_capacity, car_patent, car_brand, car_model, car_year, fleet_status)
       VALUES ($1, $2, 'Camioneta', 40, 'AB123CD', 'Ford', 'Ranger', 2020, 'active'),
              ($1, $2, 'Camioneta', 30, 'AC456EF', 'Toyota', 'Hilux', 2021, 'active')`,
      [d, dueño.user_id],
    );
  }, 300000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it('la primera corrida arma la empresa propia completa', async () => {
    // Colisión deliberada: este correo fijo ya es cliente de A. La siembra no
    // puede concederle acceso a la empresa propia por reutilizarlo.
    const [clienteAjeno] = await ds().query<Array<{ user_id: string }>>(
      `INSERT INTO "user" (full_name, email, phone_number)
       VALUES ('Cliente ajeno', $1, $2) RETURNING user_id`,
      [CLIENTES_DE_PRUEBA[0].email, telefonoDePrueba()],
    );
    await ds().query(`INSERT INTO customer (user_id) VALUES ($1)`, [
      clienteAjeno.user_id,
    ]);
    await ds().query(
      `INSERT INTO customer_distributor (user_id, distributor_id) VALUES ($1, $2)`,
      [clienteAjeno.user_id, e.distA.id],
    );
    const r = await sembrarEmpresaPropia(deps());
    const [dist] = await ds().query<Array<Record<string, unknown>>>(
      `SELECT name, owned_by_platform, status FROM distributor WHERE distributor_id = $1`,
      [r.distributorId],
    );
    const [galpon] = await ds().query<Array<Record<string, unknown>>>(
      `SELECT name, ST_Y(location) AS lat, ST_X(location) AS lng FROM warehouse
        WHERE distributor_id = $1 AND is_default`,
      [r.distributorId],
    );
    const [stock] = await ds().query<Array<{ n: string }>>(
      `SELECT coalesce(sum(b.quantity), 0) AS n FROM stock_balance b
         JOIN stock_location l ON l.location_id = b.location_id
        WHERE l.distributor_id = $1 AND b.condition = 'full'`,
      [r.distributorId],
    );
    const [promos] = await ds().query<Array<{ n: string }>>(
      `SELECT count(*) AS n FROM gas_cylinder_promotion p
         JOIN gas_cylinder g ON g.gas_cylinder_id = p.gas_cylinder_id
        WHERE g.distributor_id = $1`,
      [r.distributorId],
    );
    const [vinculos] = await ds().query<Array<{ n: string }>>(
      `SELECT count(*) AS n FROM customer_distributor
        WHERE distributor_id = $1 AND removed_at IS NULL`,
      [r.distributorId],
    );
    expect({
      dist,
      galpon,
      stock: Number(stock.n),
      promos: Number(promos.n),
      vinculos: Number(vinculos.n),
      resumen: r,
      llamadasAFirebase: crearEnFirebase.mock.calls.length,
    }).toMatchObject({
      dist: {
        name: EMPRESA_PROPIA.name,
        owned_by_platform: true,
        status: 'active',
      },
      galpon: {
        name: 'Galpón Posadas',
        lat: GALPON_POSADAS.lat,
        lng: GALPON_POSADAS.lng,
      },
      stock: 65,
      promos: 1,
      vinculos: 4,
      resumen: {
        creada: true,
        productos: 2,
        franjas: 1,
        zonas: 2,
        vehiculos: 2,
        asignaciones: 2,
        direcciones: 5,
        choferes: CHOFERES_DE_PRUEBA.map((c) => ({
          email: c.email,
          estado: 'creada',
        })),
        clientes: [
          {
            email: CLIENTES_DE_PRUEBA[0].email,
            estado: 'omitida: ya es cliente de otra empresa',
          },
          ...CLIENTES_DE_PRUEBA.slice(1).map((c) => ({
            email: c.email,
            estado: 'creada',
          })),
        ],
      },
      llamadasAFirebase: 6,
    });
    const vinculoAjeno = await ds().query<Array<{ distributor_id: string }>>(
      `SELECT distributor_id FROM customer_distributor WHERE user_id = $1`,
      [clienteAjeno.user_id],
    );
    expect(vinculoAjeno).toEqual([{ distributor_id: e.distA.id }]);
  });

  it('la segunda corrida no crea nada ni llama a Firebase (idempotente)', async () => {
    const antes = crearEnFirebase.mock.calls.length;
    const r = await sembrarEmpresaPropia(deps());
    expect({
      resumen: r,
      llamadas: crearEnFirebase.mock.calls.length - antes,
    }).toMatchObject({
      resumen: {
        creada: false,
        productos: 0,
        franjas: 0,
        zonas: 0,
        vehiculos: 0,
        asignaciones: 0,
        direcciones: 0,
        choferes: CHOFERES_DE_PRUEBA.map((c) => ({
          email: c.email,
          estado: 'ya existía',
        })),
      },
      llamadas: 0,
    });
  });

  it('sin la demo de origen avisa y no toca nada', async () => {
    await expect(
      sembrarEmpresaPropia({ ...deps(), origen: 'no-existe' }),
    ).rejects.toThrow("No existe la distribuidora 'no-existe'");
  });

  it('el super admin la opera directo: lee las franjas copiadas', async () => {
    const res = await request(env.app.getHttpServer())
      .get('/time-slot')
      .set(cabecerasDe_(e.superAdmin.email, 'panel-app', EMPRESA_PROPIA.slug));
    expect({
      estado: res.status,
      nombres: (res.body as Array<{ name: string }>).map((f) => f.name),
    }).toEqual({ estado: 200, nombres: ['Mañana'] });
  });

  it('si la distribuidora existente no está marcada, informa y no la marca por SQL', async () => {
    await ds().query(
      `UPDATE distributor SET owned_by_platform = false WHERE slug = $1`,
      [EMPRESA_PROPIA.slug],
    );
    const log = jest.fn();
    const r = await sembrarEmpresaPropia({ ...deps(), log });
    const [fila] = await ds().query<Array<{ owned_by_platform: boolean }>>(
      `SELECT owned_by_platform FROM distributor WHERE slug = $1`,
    );
    expect(r).toMatchObject({ creada: false, omitidaPorNoSerPropia: true });
    expect(fila.owned_by_platform).toBe(false);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('no está marcada'),
    );
  });
});
