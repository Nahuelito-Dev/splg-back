/**
 * La migración FlotaAmpliada sobre una base que ya tenía distribuidoras: les
 * agrega la habilitación de mercancías peligrosas, reconoce su seguro y su VTV
 * por nombre, y se puede deshacer y volver a aplicar.
 */
import { join } from 'path';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';

describe('Migración FlotaAmpliada (e2e)', () => {
  let contenedor: StartedPostgreSqlContainer;
  let ds: DataSource;

  beforeAll(async () => {
    contenedor = await new PostgreSqlContainer(
      process.env.TEST_POSTGIS_IMAGE ?? 'postgis/postgis:14-3.4',
    )
      .withDatabase('splg_flota_migracion')
      .withUsername('test')
      .withPassword('test')
      .start();
    const raiz = join(__dirname, '..', '..', 'src');
    ds = new DataSource({
      type: 'postgres',
      host: contenedor.getHost(),
      port: contenedor.getPort(),
      username: contenedor.getUsername(),
      password: contenedor.getPassword(),
      database: contenedor.getDatabase(),
      entities: [join(raiz, '**', '*.entity.ts')],
      migrations: [join(raiz, 'migrations', '*.ts')],
      synchronize: false,
    });
    await ds.initialize();
  }, 180000);

  afterAll(async () => {
    await ds?.destroy();
    await contenedor?.stop();
  });

  const planes = (distributorId: string) =>
    ds.query<Array<{ name: string; document_kind: string | null }>>(
      `SELECT name, document_kind FROM maintenance_plan WHERE distributor_id = $1 ORDER BY name`,
      [distributorId],
    );

  it('deshacer y volver a aplicar deja las distribuidoras existentes con sus planes reconocidos y la habilitación', async () => {
    await ds.runMigrations();
    // Se vuelve al estado anterior a la flota ampliada.
    await ds.undoLastMigration();
    const columnas = await ds.query<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'maintenance_plan' AND column_name = 'document_kind'`,
    );
    expect(columnas).toEqual([]);

    // Una distribuidora de antes, con los 4 planes base de entonces.
    const [{ distributor_id: distributorId }] = await ds.query<
      Array<{ distributor_id: string }>
    >(
      `INSERT INTO distributor (name, slug) VALUES ('Vieja', 'vieja') RETURNING distributor_id`,
    );
    await ds.query(
      `INSERT INTO maintenance_plan (distributor_id, name, subject, "trigger", lead_time_days, criticality, is_active)
       VALUES ($1, 'Seguro del vehículo', 'vehicle', 'by_fixed_date', 30, 'blocking', true),
              ($1, 'VTV', 'vehicle', 'by_fixed_date', 30, 'blocking', true),
              ($1, 'Licencia de conducir', 'driver', 'by_fixed_date', 30, 'blocking', true),
              ($1, 'Service / cambio de aceite', 'vehicle', 'by_km', 15, 'non_blocking', true)`,
      [distributorId],
    );

    await ds.runMigrations();

    expect(await planes(distributorId)).toEqual([
      {
        name: 'Habilitación para transporte de mercancías peligrosas',
        document_kind: 'hazmat_vehicle_permit',
      },
      { name: 'Licencia de conducir', document_kind: null },
      { name: 'Seguro del vehículo', document_kind: 'insurance' },
      { name: 'Service / cambio de aceite', document_kind: null },
      { name: 'VTV', document_kind: 'vtv' },
    ]);
    const [habilitacion] = await ds.query<
      Array<{
        subject: string;
        trigger: string;
        lead_time_days: number;
        criticality: string;
      }>
    >(
      `SELECT subject, "trigger", lead_time_days, criticality FROM maintenance_plan WHERE document_kind = 'hazmat_vehicle_permit'`,
    );
    expect(habilitacion).toEqual({
      subject: 'vehicle',
      trigger: 'by_fixed_date',
      lead_time_days: 30,
      criticality: 'blocking',
    });
  }, 240000);

  it('aplicada dos veces la siembra no duplica la habilitación', async () => {
    const [{ distributor_id: distributorId }] = await ds.query<
      Array<{ distributor_id: string }>
    >(
      `INSERT INTO distributor (name, slug) VALUES ('Otra', 'otra') RETURNING distributor_id`,
    );
    await ds.undoLastMigration();
    await ds.runMigrations();
    await ds.undoLastMigration();
    await ds.runMigrations();
    const filas = await ds.query<Array<{ n: string }>>(
      `SELECT count(*) AS n FROM maintenance_plan WHERE distributor_id = $1 AND document_kind = 'hazmat_vehicle_permit'`,
      [distributorId],
    );
    expect(Number(filas[0].n)).toBe(1);
  }, 240000);
});
