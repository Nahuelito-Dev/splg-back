import { MigrationInterface, QueryRunner } from 'typeorm';
import { partirNombreCompleto } from '../employee/domain/nombre';

/** Marca del legajo que genera esta migración: el administrador la ve y completa DNI y CUIL. */
const NOTA_DE_BACKFILL =
  'Legajo generado por la migración de personal: completar DNI y CUIL.';

interface Candidato {
  user_id: string;
  distributor_id: string;
  full_name: string | null;
  hire_date: string;
}

type Categoria = 'driver' | 'administration';

/** `QueryRunner.query` devuelve `any`: acá se declara la forma de las filas que cada consulta devuelve. */
async function consultar<T>(
  queryRunner: QueryRunner,
  sql: string,
  parametros?: unknown[],
): Promise<T[]> {
  const filas: unknown = await queryRunner.query(sql, parametros);
  return filas as T[];
}

/**
 * Backfill de §2.7 (3) del diseño del módulo Personal, sólo empleados: un
 * `employee` por cada chofer (`delivery`) vigente, con el puesto "Chofer", y
 * uno por cada `admin` de distribuidora, con el puesto "Administración".
 *
 * - Nombre y apellido: `user.full_name` partido a mejor esfuerzo con
 *   `partirNombreCompleto` (función pura sin dependencias).
 * - `document_number` = `PENDIENTE-<legajo>`, `hire_date` = el alta del perfil
 *   (día argentino), `notes` = la marca de arriba.
 * - El número de legajo sale de `document_sequence` (`employee_file`), así el
 *   legajo que se cree después sigue la numeración.
 *
 * Idempotente: no toca a quien ya tiene un legajo vigente. Reversible: `down`
 * borra los legajos que conservan la marca y deja la secuencia en el mayor
 * número que queda.
 */
export class BackfillDeEmpleados1791160100000 implements MigrationInterface {
  name = 'BackfillDeEmpleados1791160100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const choferes = await consultar<Candidato>(
      queryRunner,
      `
      SELECT u."user_id", dl."distributor_id", u."full_name",
             to_char((COALESCE(dl."createdAt", now()) AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, 'YYYY-MM-DD') AS hire_date
      FROM "delivery" dl
      JOIN "user" u ON u."user_id" = dl."user_id"
      WHERE dl."deletedAt" IS NULL AND u."deletedAt" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "employee" e WHERE e."user_id" = u."user_id" AND e."deletedAt" IS NULL)
      ORDER BY dl."distributor_id", dl."createdAt", u."user_id"
    `,
    );
    const admins = await consultar<Candidato>(
      queryRunner,
      `
      SELECT u."user_id", a."distributor_id", u."full_name",
             to_char((COALESCE(a."createdAt", now()) AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, 'YYYY-MM-DD') AS hire_date
      FROM "admin" a
      JOIN "user" u ON u."user_id" = a."user_id"
      JOIN "role" r ON r."role_id" = u."role_id"
      WHERE a."distributor_id" IS NOT NULL AND r."type" = 'admin' AND u."deletedAt" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "employee" e WHERE e."user_id" = u."user_id" AND e."deletedAt" IS NULL)
      ORDER BY a."distributor_id", a."createdAt", u."user_id"
    `,
    );

    for (const c of choferes) await this.crear(queryRunner, c, 'driver');
    for (const c of admins) await this.crear(queryRunner, c, 'administration');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "employee" WHERE "notes" LIKE $1`, [
      `${NOTA_DE_BACKFILL}%`,
    ]);
    await queryRunner.query(`
      UPDATE "document_sequence" ds
      SET "last_number" = COALESCE((
        SELECT max(e."file_number"::int) FROM "employee" e
        WHERE e."distributor_id" = ds."distributor_id" AND e."file_number" ~ '^[0-9]{1,9}$'
      ), 0)
      WHERE ds."doc_type" = 'employee_file'
    `);
    await queryRunner.query(
      `DELETE FROM "document_sequence" WHERE "doc_type" = 'employee_file' AND "last_number" = 0`,
    );
  }

  private async crear(
    queryRunner: QueryRunner,
    candidato: Candidato,
    categoria: Categoria,
  ): Promise<void> {
    const puestoId = await this.puesto(
      queryRunner,
      candidato.distributor_id,
      categoria,
    );
    const legajo = await this.siguienteLegajo(
      queryRunner,
      candidato.distributor_id,
    );
    const { firstName, lastName } = partirNombreCompleto(candidato.full_name);
    await queryRunner.query(
      `INSERT INTO "employee"
         ("distributor_id", "user_id", "position_id", "file_number", "first_name", "last_name",
          "document_type", "document_number", "hire_date", "employment_type", "status", "notes")
       VALUES ($1, $2, $3, $4, $5, $6, 'dni', $7, $8, 'permanent', 'active', $9)`,
      [
        candidato.distributor_id,
        candidato.user_id,
        puestoId,
        legajo,
        firstName,
        lastName,
        `PENDIENTE-${legajo}`,
        candidato.hire_date,
        NOTA_DE_BACKFILL,
      ],
    );
  }

  /** El puesto vigente más antiguo de la categoría; si no hay, crea el base. */
  private async puesto(
    queryRunner: QueryRunner,
    distributorId: string,
    categoria: Categoria,
  ): Promise<string> {
    const existente = await consultar<{ position_id: string }>(
      queryRunner,
      `SELECT "position_id" FROM "job_position"
       WHERE "distributor_id" = $1 AND "category" = $2 AND "deletedAt" IS NULL
       ORDER BY "is_active" DESC, "createdAt", "position_id" LIMIT 1`,
      [distributorId, categoria],
    );
    if (existente.length > 0) return existente[0].position_id;

    const nombre = categoria === 'driver' ? 'Chofer' : 'Administración';
    const creado = await consultar<{ position_id: string }>(
      queryRunner,
      `INSERT INTO "job_position" ("distributor_id", "name", "category")
       VALUES ($1, CASE WHEN EXISTS (
                 SELECT 1 FROM "job_position" WHERE "distributor_id" = $1
                   AND lower("name") = lower($2) AND "deletedAt" IS NULL)
               THEN $2 || ' (migración)' ELSE $2 END, $3)
       RETURNING "position_id"`,
      [distributorId, nombre, categoria],
    );
    return creado[0].position_id;
  }

  /** Siguiente número de legajo libre (salta los que alguien cargó a mano). */
  private async siguienteLegajo(
    queryRunner: QueryRunner,
    distributorId: string,
  ): Promise<string> {
    for (;;) {
      const filas = await consultar<{ last_number: number }>(
        queryRunner,
        `INSERT INTO "document_sequence" ("distributor_id", "doc_type", "last_number")
         VALUES ($1, 'employee_file', 1)
         ON CONFLICT ("distributor_id", "doc_type")
         DO UPDATE SET "last_number" = "document_sequence"."last_number" + 1
         RETURNING "last_number"`,
        [distributorId],
      );
      const legajo = String(filas[0].last_number).padStart(4, '0');
      const ocupado = await consultar<unknown>(
        queryRunner,
        `SELECT 1 FROM "employee"
         WHERE "distributor_id" = $1 AND "deletedAt" IS NULL
           AND ("file_number" = $2 OR "document_number" = $3)`,
        [distributorId, legajo, `PENDIENTE-${legajo}`],
      );
      if (ocupado.length === 0) return legajo;
    }
  }
}
