/**
 * La migración DocumentacionAsistenciaYLicenciasDelPersonal contra un Postgres
 * con datos: completa los planes base existentes, siembra los de personal para
 * las distribuidoras que ya existen, deja a la base como último freno contra
 * dos licencias que se pisan (trigger con lock por empleado, también entre
 * transacciones simultáneas) y se puede deshacer.
 */
import { readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { DocumentacionAsistenciaYLicenciasDelPersonal1792080000000 } from '../../src/migrations/1792080000000-DocumentacionAsistenciaYLicenciasDelPersonal';

describe('Migración DocumentacionAsistenciaYLicenciasDelPersonal (e2e)', () => {
  let pg: StartedPostgreSqlContainer;
  let ds: DataSource;

  const nuevo = (migraciones: string[]) =>
    new DataSource({
      type: 'postgres',
      host: pg.getHost(),
      port: pg.getPort(),
      username: pg.getUsername(),
      password: pg.getPassword(),
      database: pg.getDatabase(),
      entities: [join(__dirname, '../../src/**/*.entity.ts')],
      migrations: migraciones,
      synchronize: false,
      // Como `src/data-source.ts`: un valor nuevo de un enum no se puede usar en
      // la misma transacción que lo agrega.
      migrationsTransactionMode: 'each',
    });

  const dir = join(__dirname, '../../src/migrations');
  const todas = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => join(dir, f));
  const anteriores = todas.slice(
    0,
    todas.findIndex((f) =>
      /DocumentacionAsistenciaYLicenciasDelPersonal/.test(f),
    ),
  );
  // Hasta esta migración inclusive: el esquema que deja, sin las posteriores
  // (que siembran más planes y que `undoLastMigration` tendría que deshacer
  // primero).
  const hastaEsta = todas.slice(0, anteriores.length + 1);

  const distA = randomUUID();
  const distB = randomUUID();
  const empleado = randomUUID();
  const otroEmpleado = randomUUID();

  async function crearEmpleado(
    id: string,
    distributorId: string,
    puesto: string,
    n: number,
  ) {
    await ds.query(
      `INSERT INTO "employee" ("employee_id", "distributor_id", "position_id", "file_number", "first_name", "last_name",
                               "document_type", "document_number", "hire_date", "employment_type")
       VALUES ($1, $2, $3, $4, 'Ana', 'Pérez', 'dni', $5, '2024-01-01', 'permanent')`,
      [id, distributorId, puesto, `000${n}`, `3000000${n}`],
    );
  }

  const licencia = (
    employeeId: string,
    inicio: string,
    fin: string,
    estado = 'requested',
  ) =>
    ds.query(
      `INSERT INTO "employee_leave" ("distributor_id", "employee_id", "type", "start_date", "end_date", "days", "status")
       VALUES ($1, $2, 'vacation', $3, $4, 1, $5)`,
      [distA, employeeId, inicio, fin, estado],
    );

  const codigoDe = (e: unknown) => (e as { code?: string }).code;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer(
      process.env.TEST_POSTGIS_IMAGE ?? 'postgis/postgis:14-3.4',
    )
      .withDatabase('splg_test')
      .withUsername('test')
      .withPassword('test')
      .start();

    ds = nuevo(anteriores);
    await ds.initialize();
    await ds.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await ds.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await ds.runMigrations();

    await ds.query(
      `INSERT INTO "distributor" ("distributor_id", "name", "slug") VALUES ($1, 'A', 'a'), ($2, 'B', 'b')`,
      [distA, distB],
    );
    // Los 4 planes base como los dejó la siembra anterior (sin tipo de documento).
    for (const d of [distA, distB]) {
      await ds.query(
        `INSERT INTO "maintenance_plan" ("distributor_id", "name", "subject", "trigger", "lead_time_days", "criticality")
         VALUES ($1, 'Seguro del vehículo', 'vehicle', 'by_fixed_date', 30, 'blocking'),
                ($1, 'VTV', 'vehicle', 'by_fixed_date', 30, 'blocking'),
                ($1, 'Licencia de conducir', 'driver', 'by_fixed_date', 30, 'blocking'),
                ($1, 'Service / cambio de aceite', 'vehicle', 'by_km', 15, 'non_blocking')`,
        [d],
      );
    }
    // La distribuidora B ya tiene un plan propio con el nombre de uno nuevo: no se duplica.
    await ds.query(
      `INSERT INTO "maintenance_plan" ("distributor_id", "name", "subject", "trigger", "lead_time_days", "criticality")
       VALUES ($1, 'Alta en ART', 'vehicle', 'by_fixed_date', 10, 'non_blocking')`,
      [distB],
    );
    const puesto = randomUUID();
    await ds.query(
      `INSERT INTO "job_position" ("position_id", "distributor_id", "name", "category") VALUES ($1, $2, 'Chofer', 'driver')`,
      [puesto, distA],
    );
    await crearEmpleado(empleado, distA, puesto, 1);
    await crearEmpleado(otroEmpleado, distA, puesto, 2);
    await ds.destroy();

    ds = nuevo(hastaEsta);
    await ds.initialize();
    await ds.runMigrations();
  }, 300000);

  afterAll(async () => {
    await ds?.destroy();
    await pg?.stop();
  });

  it('completa el tipo de documento y las categorías de los 4 planes base existentes', async () => {
    const filas = await ds.query<
      Array<{
        name: string;
        document_kind: string;
        applies_to_categories: string[] | null;
      }>
    >(
      `SELECT name, document_kind, applies_to_categories FROM maintenance_plan
       WHERE distributor_id = $1 AND subject::text IN ('vehicle', 'driver') ORDER BY name`,
      [distA],
    );
    expect(filas).toEqual([
      {
        name: 'Licencia de conducir',
        document_kind: 'driver_license',
        applies_to_categories: ['driver'],
      },
      {
        name: 'Seguro del vehículo',
        document_kind: 'insurance',
        applies_to_categories: null,
      },
      {
        name: 'Service / cambio de aceite',
        document_kind: 'service',
        applies_to_categories: null,
      },
      { name: 'VTV', document_kind: 'vtv', applies_to_categories: null },
    ]);
  });

  it('siembra los 3 planes de personal en cada distribuidora que ya existía, sin duplicar el que ya había (un plan de otro sujeto con el mismo nombre no lo impide)', async () => {
    const filas = await ds.query<
      Array<{
        name: string;
        criticality: string;
        lead_time_days: number;
        document_kind: string;
        applies_to_categories: string[] | null;
      }>
    >(
      `SELECT name, criticality, lead_time_days, document_kind, applies_to_categories FROM maintenance_plan
       WHERE distributor_id = $1 AND subject::text = 'employee' ORDER BY name`,
      [distA],
    );
    expect(filas).toEqual([
      {
        name: 'Alta en ART',
        criticality: 'non_blocking',
        lead_time_days: 30,
        document_kind: 'art_coverage',
        applies_to_categories: null,
      },
      {
        name: 'Curso de transporte de mercancías peligrosas (GLP)',
        criticality: 'blocking',
        lead_time_days: 60,
        document_kind: 'hazmat_driver_course',
        applies_to_categories: ['driver'],
      },
      {
        name: 'Examen psicofísico',
        criticality: 'blocking',
        lead_time_days: 30,
        document_kind: 'psychophysical',
        applies_to_categories: ['driver'],
      },
    ]);
    const deB = await ds.query<Array<{ name: string; subject: string }>>(
      `SELECT name, subject::text AS subject FROM maintenance_plan WHERE distributor_id = $1 AND name = 'Alta en ART' ORDER BY subject`,
      [distB],
    );
    expect(deB).toEqual([
      { name: 'Alta en ART', subject: 'employee' },
      { name: 'Alta en ART', subject: 'vehicle' },
    ]);
  });

  describe('trigger contra licencias superpuestas', () => {
    beforeEach(async () => {
      await ds.query(`DELETE FROM "employee_leave"`);
    });

    it('rechaza (23P01) una solicitada o aprobada que pisa a otra del mismo empleado', async () => {
      await licencia(empleado, '2099-12-01', '2099-12-14', 'approved');

      await expect(
        licencia(empleado, '2099-12-14', '2099-12-20'),
      ).rejects.toMatchObject({ code: '23P01' });
      await expect(
        licencia(empleado, '2099-11-20', '2099-12-01', 'approved'),
      ).rejects.toMatchObject({ code: '23P01' });
    });

    it('deja pasar la contigua, la de otro empleado y la que no ocupa el período (rechazada o cancelada)', async () => {
      await licencia(empleado, '2099-12-01', '2099-12-14');

      await licencia(empleado, '2099-12-15', '2099-12-16');
      await licencia(otroEmpleado, '2099-12-01', '2099-12-14');
      await licencia(empleado, '2099-12-05', '2099-12-06', 'rejected');
      await licencia(empleado, '2099-12-05', '2099-12-06', 'cancelled');

      const n = await ds.query<Array<{ n: string }>>(
        `SELECT count(*) AS n FROM employee_leave`,
      );
      expect(Number(n[0].n)).toBe(5);
    });

    it('un UPDATE que vuelve a ocupar el período también se frena', async () => {
      await licencia(empleado, '2099-12-01', '2099-12-14');
      await licencia(empleado, '2099-12-05', '2099-12-06', 'cancelled');

      await expect(
        ds.query(
          `UPDATE "employee_leave" SET "status" = 'requested' WHERE "start_date" = '2099-12-05'`,
        ),
      ).rejects.toMatchObject({ code: '23P01' });
    });

    it('dos transacciones simultáneas sobre el mismo empleado se serializan: la segunda ve a la primera y falla', async () => {
      const q1 = ds.createQueryRunner();
      const q2 = ds.createQueryRunner();
      await q1.connect();
      await q2.connect();
      try {
        await q1.startTransaction();
        await q2.startTransaction();
        const insertar = `INSERT INTO "employee_leave" ("distributor_id", "employee_id", "type", "start_date", "end_date", "days", "status")
                          VALUES ('${distA}', '${empleado}', 'vacation', '2099-12-01', '2099-12-14', 14, 'requested')`;
        await q1.query(insertar);

        const segunda = q2.query(insertar).then(
          () => 'ok',
          (e: unknown) => codigoDe(e),
        );
        await new Promise((r) => setTimeout(r, 400)); // la segunda espera el lock de la primera
        await q1.commitTransaction();

        expect(await segunda).toBe('23P01');
      } finally {
        await q2.rollbackTransaction().catch(() => undefined);
        await q1.release();
        await q2.release();
      }
    });
  });

  it('una asistencia abierta por empleado: el índice único parcial frena la segunda', async () => {
    const abrir = () =>
      ds.query(
        `INSERT INTO "employee_attendance" ("distributor_id", "employee_id", "work_date", "check_in_at", "source")
         VALUES ($1, $2, '2026-03-02', now(), 'panel')`,
        [distA, empleado],
      );
    await abrir();
    await expect(abrir()).rejects.toMatchObject({ code: '23505' });
  });

  it('no se deshace si hay jornadas o licencias cargadas', async () => {
    // La prueba de concurrencia de arriba deja confirmada una licencia en ese período.
    await ds.query(`DELETE FROM "employee_leave"`);
    await licencia(empleado, '2099-12-01', '2099-12-14');
    const runner = ds.createQueryRunner();
    try {
      await expect(
        new DocumentacionAsistenciaYLicenciasDelPersonal1792080000000().down(
          runner,
        ),
      ).rejects.toThrow(/jornadas o licencias cargadas/);
    } finally {
      await runner.release();
    }
    await ds.query(`DELETE FROM "employee_leave"`);
    await ds.query(`DELETE FROM "employee_attendance"`);
  });

  it('se puede deshacer si no hay documentación de personal cargada, y vuelve a aplicarse', async () => {
    const runner = ds.createQueryRunner();
    try {
      const migracion =
        new DocumentacionAsistenciaYLicenciasDelPersonal1792080000000();
      await migracion.down(runner);
      const tablas = await ds.query<Array<{ t: string }>>(
        `SELECT table_name AS t FROM information_schema.tables WHERE table_name IN ('employee_leave', 'employee_attendance')`,
      );
      expect(tablas).toEqual([]);
      const planes = await ds.query<Array<{ n: string }>>(
        `SELECT count(*) AS n FROM maintenance_plan WHERE name IN ('Examen psicofísico', 'Curso de transporte de mercancías peligrosas (GLP)')`,
      );
      expect(Number(planes[0].n)).toBe(0);

      await migracion.up(runner);
      const otra = await ds.query<Array<{ n: string }>>(
        `SELECT count(*) AS n FROM maintenance_plan WHERE subject::text = 'employee'`,
      );
      expect(Number(otra[0].n)).toBe(6); // 3 por cada distribuidora
    } finally {
      await runner.release();
    }
  });

  it('no se deshace si hay documentación de personal cargada', async () => {
    const [plan] = await ds.query<Array<{ plan_id: string }>>(
      `SELECT plan_id FROM maintenance_plan WHERE distributor_id = $1 AND name = 'Alta en ART'`,
      [distA],
    );
    await ds.query(
      `INSERT INTO "maintenance_task" ("plan_id", "distributor_id", "employee_id", "status", "due_at")
       VALUES ($1, $2, $3, 'scheduled', now())`,
      [plan.plan_id, distA, empleado],
    );
    const runner = ds.createQueryRunner();
    try {
      await expect(
        new DocumentacionAsistenciaYLicenciasDelPersonal1792080000000().down(
          runner,
        ),
      ).rejects.toThrow(/documentación de personal cargada/);
    } finally {
      await runner.release();
    }
  });
});
