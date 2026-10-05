import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CU-176: siembra los 5 puestos base (Chofer, Ayudante, Depósito,
 * Administración, Vendedor) para las distribuidoras que ya existen. Las que se
 * creen de ahora en más los reciben por el evento `distribuidora.creada` (ver
 * `JobPositionSeedListener`): acá sólo el backfill de las viejas.
 *
 * Idempotente: no duplica un puesto si la distribuidora ya tiene uno con ese
 * nombre (sin distinguir mayúsculas).
 *
 * MISMOS valores que `employee/domain/base-positions.ts`: si se cambia uno, se
 * cambia en los dos lados.
 */
export class SembrarPuestosDeTrabajo1791160000000
  implements MigrationInterface
{
  name = 'SembrarPuestosDeTrabajo1791160000000';

  private readonly nombresDeLosPuestosBase = [
    'Chofer',
    'Ayudante',
    'Depósito',
    'Administración',
    'Vendedor',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "job_position" ("position_id", "distributor_id", "name", "category")
      SELECT uuid_generate_v4(), d."distributor_id", v.name, v.category::"job_position_category_enum"
      FROM "distributor" d
      CROSS JOIN (VALUES
        ('Chofer', 'driver'),
        ('Ayudante', 'helper'),
        ('Depósito', 'warehouse'),
        ('Administración', 'administration'),
        ('Vendedor', 'sales')
      ) AS v(name, category)
      WHERE NOT EXISTS (
        SELECT 1 FROM "job_position" jp
        WHERE jp."distributor_id" = d."distributor_id"
          AND lower(jp."name") = lower(v.name)
          AND jp."deletedAt" IS NULL
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Sólo se quitan los puestos base que nadie usa: ninguno referenciado por
    // un legajo (vigente, egresado o dado de baja). Un puesto con el mismo
    // nombre creado por un usuario no se puede distinguir del sembrado: si
    // está en uso se conserva, y si no lo está se quita junto con los demás.
    await queryRunner.query(
      `DELETE FROM "job_position" jp
       WHERE jp."name" = ANY($1)
         AND NOT EXISTS (SELECT 1 FROM "employee" e WHERE e."position_id" = jp."position_id")`,
      [this.nombresDeLosPuestosBase],
    );
  }
}
