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
      // Como `src/data-source.ts`: un valor nuevo de un enum no se puede usar en
      // la misma transacción que lo agrega.
      migrationsTransactionMode: 'each',
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

  /**
   * Deshace desde la última hasta FlotaAmpliada inclusive. En una base nueva
   * corren, por timestamp: personal (1792080000000), flota (1792186500123) y las
   * que vengan después; `undoLastMigration` deshace de a una, de la última.
   */
  const deshacerHastaFlota = async () => {
    for (;;) {
      const aplicadas = await ds.query<Array<{ name: string }>>(
        `SELECT name FROM migrations WHERE name LIKE 'FlotaAmpliada%'`,
      );
      if (aplicadas.length === 0) return;
      await ds.undoLastMigration();
    }
  };

  it('deshacer y volver a aplicar deja las distribuidoras existentes con sus planes reconocidos y la habilitación', async () => {
    await ds.runMigrations();
    // Se vuelve al estado anterior a la flota ampliada. La documentación del
    // personal (que corre antes) sigue aplicada y es dueña de `document_kind`:
    // la columna se queda.
    await deshacerHastaFlota();
    const columnas = await ds.query<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'maintenance_plan' AND column_name = 'document_kind'`,
    );
    expect(columnas).toHaveLength(1);
    const tablas = await ds.query<Array<{ t: string | null }>>(
      `SELECT to_regclass('public.fuel_load') AS t`,
    );
    expect(tablas[0].t).toBeNull();

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
    await deshacerHastaFlota();
    await ds.runMigrations();
    await deshacerHastaFlota();
    await ds.runMigrations();
    const filas = await ds.query<Array<{ n: string }>>(
      `SELECT count(*) AS n FROM maintenance_plan WHERE distributor_id = $1 AND document_kind = 'hazmat_vehicle_permit'`,
      [distributorId],
    );
    expect(Number(filas[0].n)).toBe(1);
  }, 240000);

  it('deshacer la flota con habilitaciones cargadas frena con un mensaje claro, sin fallar por la clave foránea', async () => {
    const [{ distributor_id: distributorId }] = await ds.query<
      Array<{ distributor_id: string }>
    >(
      `INSERT INTO distributor (name, slug) VALUES ('Con tareas', 'con-tareas') RETURNING distributor_id`,
    );
    await ds.query(
      `INSERT INTO maintenance_plan (distributor_id, name, subject, "trigger", lead_time_days, criticality, is_active, document_kind)
       VALUES ($1, 'Habilitación', 'vehicle', 'by_fixed_date', 30, 'blocking', true, 'hazmat_vehicle_permit')`,
      [distributorId],
    );
    // La tarea es de un vehículo (CHK_maintenance_task_un_sujeto).
    const [{ user_id: userId }] = await ds.query<Array<{ user_id: string }>>(
      `INSERT INTO "user" (email) VALUES ('chofer@con-tareas.com') RETURNING user_id`,
    );
    const [{ car_id: carId }] = await ds.query<Array<{ car_id: string }>>(
      `INSERT INTO car (distributor_id, user_id, car_patent) VALUES ($1, $2, 'AB123CD') RETURNING car_id`,
      [distributorId, userId],
    );
    await ds.query(
      `INSERT INTO maintenance_task (plan_id, distributor_id, car_id, status)
       SELECT plan_id, distributor_id, $2, 'scheduled' FROM maintenance_plan WHERE distributor_id = $1`,
      [distributorId, carId],
    );
    await expect(deshacerHastaFlota()).rejects.toThrow(
      /habilitaciones de mercancías peligrosas cargadas/,
    );
  }, 240000);
});
