/**
 * `scripts/lib/completar-fotos.ts` contra un Postgres y un MinIO efímeros (con
 * toda la cadena de migraciones): reemplaza URLs externas y keys rotas, no
 * toca lo que ya está bien y una segunda corrida no sube nada.
 */
import { join } from 'path';
import { randomUUID } from 'crypto';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { S3Service } from '../../src/s3/s3.service';
import {
  AlmacenDeFotos,
  completarFotos,
  ResumenDeTabla,
} from '../../scripts/lib/completar-fotos';
import { S3CleanupService } from '../../src/s3/s3-cleanup.service';
import { StorageOrphan } from '../../src/s3/entities/storage-orphan.entity';
import { BUCKET_DE_PRUEBA, startMinio, TestMinio } from './setup/minio';

const IMAGEN_POSTGIS =
  process.env.TEST_POSTGIS_IMAGE ?? 'postgis/postgis:14-3.4';

describe('completar fotos de la demo (e2e)', () => {
  let pg: StartedPostgreSqlContainer;
  let minio: TestMinio;
  let ds: DataSource;
  let almacen: AlmacenDeFotos;
  let cleanup: S3CleanupService;
  let puts: string[];
  let distId: string;
  const ids: Record<string, string[]> = {};

  async function consultar<T>(sql: string, params: unknown[] = []) {
    const filas: unknown = await ds.query(sql, params);
    return filas as T[];
  }

  /** Inserta una fila completando con valores neutros las columnas obligatorias. */
  async function insertar(
    tabla: string,
    valores: Record<string, unknown>,
  ): Promise<string> {
    const columnas = await consultar<{
      column_name: string;
      data_type: string;
      udt_name: string;
    }>(
      `SELECT column_name, data_type, udt_name FROM information_schema.columns
        WHERE table_name = $1 AND is_nullable = 'NO' AND column_default IS NULL`,
      [tabla],
    );
    const fila: Record<string, unknown> = { ...valores };
    for (const c of columnas) {
      if (c.column_name in fila) continue;
      if (c.data_type === 'uuid') fila[c.column_name] = randomUUID();
      else if (c.data_type === 'USER-DEFINED') {
        const [e] = await consultar<{ v: string }>(
          `SELECT enumlabel AS v FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
            WHERE t.typname = $1 ORDER BY enumsortorder LIMIT 1`,
          [c.udt_name],
        );
        fila[c.column_name] = e.v;
      } else if (/int|numeric|double|real/.test(c.data_type)) {
        fila[c.column_name] = 1;
      } else if (c.data_type === 'boolean') fila[c.column_name] = false;
      else if (/timestamp|date/.test(c.data_type))
        fila[c.column_name] = new Date();
      else fila[c.column_name] = randomUUID().slice(0, 8);
    }
    const nombres = Object.keys(fila);
    const [creada] = await consultar<Record<string, string>>(
      `INSERT INTO "${tabla}" (${nombres.map((n) => `"${n}"`).join(',')})
       VALUES (${nombres.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
      nombres.map((n) => fila[n]),
    );
    return Object.values(creada)[0];
  }

  const correr = (dryRun = false): Promise<ResumenDeTabla[]> =>
    completarFotos({
      ds,
      almacen,
      reservas: cleanup,
      distribuidoraId: distId,
      bucket: BUCKET_DE_PRUEBA,
      endpoint: minio.endpoint,
      dryRun,
    });

  const porNombre = (r: ResumenDeTabla[], nombre: string) =>
    r.find((x) => x.nombre.startsWith(nombre))!;

  async function existeEnBucket(key: string): Promise<boolean> {
    try {
      await minio.client.send(
        new HeadObjectCommand({ Bucket: BUCKET_DE_PRUEBA, Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }

  beforeAll(async () => {
    [pg, minio] = await Promise.all([
      new PostgreSqlContainer(IMAGEN_POSTGIS)
        .withDatabase('splg_fotos_demo')
        .withUsername('test')
        .withPassword('test')
        .start(),
      startMinio(),
    ]);
    ds = new DataSource({
      type: 'postgres',
      host: pg.getHost(),
      port: pg.getPort(),
      username: pg.getUsername(),
      password: pg.getPassword(),
      database: pg.getDatabase(),
      entities: [StorageOrphan],
      migrations: [join(__dirname, '../../src/migrations/*.ts')],
      synchronize: false,
    });
    await ds.initialize();
    await ds.runMigrations();
    // Filas sueltas: sin las FK de pedidos, clientes, etc., que no importan acá.
    await ds.query(`SET session_replication_role = replica`);

    puts = [];
    // El SDK lee las credenciales de process.env.
    Object.assign(process.env, minio.env);
    const s3 = new S3Service(new ConfigService());
    almacen = {
      async put(entrada) {
        puts.push(entrada.key);
        await s3.put(entrada);
      },
      existe: existeEnBucket,
    };
    // `S3CleanupService` sólo usa el repositorio para reservar y confirmar.
    cleanup = new S3CleanupService(s3, ds.getRepository(StorageOrphan));

    distId = await insertar('distributor', {
      slug: 'demo-fotos',
      logo_url: 'https://storage.splg.app/logo.png',
    });
    ids.claims = [
      await insertar('claims', {
        distributor_id: distId,
        photoUrl: 'https://storage.splg.app/reclamo.jpg',
      }),
      await insertar('claims', { distributor_id: distId }),
    ];
    ids.incident = [
      await insertar('incident', {
        distributor_id: distId,
        photo_url: 'https://storage.splg.app/incidencia.jpg',
      }),
    ];
    ids.gas_cylinder = [
      await insertar('gas_cylinder', { distributor_id: distId }),
      await insertar('gas_cylinder', { distributor_id: distId }),
    ];
    ids.car = [await insertar('car', { distributor_id: distId })];

    // Personas: chofer, admin, cliente (por un pedido) y alguien ajeno.
    const rolAdmin = await insertar('role', { type: 'admin' });
    const usuario = (valores: Record<string, unknown> = {}) =>
      insertar('user', { full_name: 'Persona', ...valores });
    ids.chofer = [await usuario()];
    ids.admin = [await usuario({ role_id: rolAdmin })];
    ids.cliente = [await usuario()];
    ids.ajeno = [await usuario()];
    ids.conFoto = [await usuario()];
    await insertar('delivery', {
      distributor_id: distId,
      user_id: ids.chofer[0],
    });
    await insertar('admin', { distributor_id: distId, user_id: ids.admin[0] });
    await insertar('order', {
      distributor_id: distId,
      customer_id: ids.cliente[0],
    });
    await insertar('order', {
      distributor_id: distId,
      customer_id: ids.conFoto[0],
    });
    // Un cliente compartido: también le compró a otra distribuidora.
    const otraDist = await insertar('distributor', { slug: 'otra-demo' });
    ids.compartido = [await usuario()];
    await insertar('order', {
      distributor_id: distId,
      customer_id: ids.compartido[0],
    });
    await insertar('order', {
      distributor_id: otraDist,
      customer_id: ids.compartido[0],
    });
    // Legajos: uno sin cuenta (lleva foto propia) y uno con cuenta (vale la del usuario).
    ids.employee = [
      await insertar('employee', { distributor_id: distId }),
      await insertar('employee', {
        distributor_id: distId,
        user_id: ids.chofer[0],
      }),
    ];
    const fotoDeUsuario = `users/${ids.conFoto[0]}/propia.png`;
    await almacen.put({
      key: fotoDeUsuario,
      body: Buffer.from('png'),
      contentType: 'image/png',
    });
    await ds.query(`UPDATE "user" SET photo_key = $1 WHERE user_id = $2`, [
      fotoDeUsuario,
      ids.conFoto[0],
    ]);

    // Un producto con foto buena y un vehículo con key rota.
    const buena = `gascylinders/${distId}/${ids.gas_cylinder[1]}/buena.png`;
    await almacen.put({
      key: buena,
      body: Buffer.from('png'),
      contentType: 'image/png',
    });
    await ds.query(
      `UPDATE gas_cylinder SET photo_key = $1 WHERE gas_cylinder_id = $2`,
      [buena, ids.gas_cylinder[1]],
    );
    await ds.query(`UPDATE car SET photo_key = $1 WHERE car_id = $2`, [
      `cars/${distId}/${ids.car[0]}/no-existe.png`,
      ids.car[0],
    ]);
    puts.length = 0;
  }, 300000);

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
    await Promise.all([pg?.stop(), minio?.stop()]);
  });

  it('--dry-run lista lo que haría y no escribe', async () => {
    const r = await correr(true);
    expect(porNombre(r, 'claims').subidas).toBe(2);
    expect(
      porNombre(r, 'claims')
        .detalle.map((d) => d.motivo)
        .sort(),
    ).toEqual(['URL externa', 'sin foto']);
    expect(porNombre(r, 'car').detalle[0].motivo).toBe('key rota');
    expect(porNombre(r, 'gas_cylinder').yaEstabanBien).toBe(1);
    expect(porNombre(r, 'user')).toMatchObject({
      subidas: 3,
      yaEstabanBien: 1,
    });
    expect(porNombre(r, 'employee').subidas).toBe(1);
    expect(puts).toHaveLength(0);
    const [c] = await consultar<{ photo_key: string | null }>(
      `SELECT photo_key FROM claims WHERE claim_id = $1`,
      [ids.claims[0]],
    );
    expect(c.photo_key).toBeNull();
  });

  it('reemplaza URLs externas, rellena las faltantes y repara las keys rotas', async () => {
    const r = await correr();
    expect(porNombre(r, 'claims').subidas).toBe(2);
    expect(porNombre(r, 'incident').subidas).toBe(1);
    expect(porNombre(r, 'gas_cylinder')).toMatchObject({
      subidas: 1,
      yaEstabanBien: 1,
    });
    expect(porNombre(r, 'car').subidas).toBe(1);
    expect(porNombre(r, 'distributor').subidas).toBe(1);
    expect(porNombre(r, 'user')).toMatchObject({
      subidas: 3,
      yaEstabanBien: 1,
    });
    expect(porNombre(r, 'employee').subidas).toBe(1);
    expect(puts).toHaveLength(10);

    // Chofer, admin y cliente tienen avatar; el ajeno no; el que ya tenía, la suya.
    const fotos = await consultar<{ id: string; k: string | null }>(
      `SELECT user_id AS id, photo_key AS k FROM "user"`,
    );
    const keyDe = (id: string) => fotos.find((f) => f.id === id)?.k ?? null;
    for (const id of [ids.chofer[0], ids.admin[0], ids.cliente[0]]) {
      expect(keyDe(id)).toMatch(
        new RegExp(`^users/${id}/[0-9a-f-]{36}\\.png$`),
      );
      expect(await existeEnBucket(keyDe(id)!)).toBe(true);
    }
    expect(keyDe(ids.ajeno[0])).toBeNull();
    expect(keyDe(ids.compartido[0])).toBeNull();
    expect(keyDe(ids.conFoto[0])).toBe(`users/${ids.conFoto[0]}/propia.png`);

    // El legajo sin cuenta lleva foto; el que tiene cuenta, no (vale la del usuario).
    const legajos = await consultar<{ id: string; k: string | null }>(
      `SELECT employee_id AS id, photo_key AS k FROM employee`,
    );
    expect(legajos.find((l) => l.id === ids.employee[0])?.k).toContain(
      `employees/${distId}/${ids.employee[0]}/`,
    );
    expect(legajos.find((l) => l.id === ids.employee[1])?.k).toBeNull();

    const [reclamo] = await consultar<{ k: string; u: string | null }>(
      `SELECT photo_key AS k, "photoUrl" AS u FROM claims WHERE claim_id = $1`,
      [ids.claims[0]],
    );
    expect(reclamo.k).toMatch(
      new RegExp(`^claims/${distId}/${ids.claims[0]}/[0-9a-f-]{36}\\.png$`),
    );
    expect(reclamo.u).toBeNull();
    expect(await existeEnBucket(reclamo.k)).toBe(true);

    const [inc] = await consultar<{ u: string | null }>(
      `SELECT photo_url AS u FROM incident WHERE incident_id = $1`,
      [ids.incident[0]],
    );
    expect(inc.u).toBeNull();
    const [dist] = await consultar<{ k: string; u: string | null }>(
      `SELECT logo_key AS k, logo_url AS u FROM distributor WHERE distributor_id = $1`,
      [distId],
    );
    expect(dist.k).toContain(`distributors/${distId}/logo/`);
    expect(dist.u).toBeNull();
    const [auto] = await consultar<{ k: string }>(
      `SELECT photo_key AS k FROM car WHERE car_id = $1`,
      [ids.car[0]],
    );
    expect(auto.k).not.toContain('no-existe');
    expect(await existeEnBucket(auto.k)).toBe(true);

    // Todas las reservas quedaron confirmadas.
    const [{ n }] = await consultar<{ n: string }>(
      `SELECT count(*) AS n FROM storage_orphan`,
    );
    expect(Number(n)).toBe(0);
  });

  it('una segunda corrida no sube nada', async () => {
    puts.length = 0;
    const r = await correr();
    expect(puts).toHaveLength(0);
    expect(r.reduce((s, x) => s + x.subidas, 0)).toBe(0);
    expect(r.reduce((s, x) => s + x.fallidas, 0)).toBe(0);
    expect(porNombre(r, 'claims').yaEstabanBien).toBe(2);
  });
});
