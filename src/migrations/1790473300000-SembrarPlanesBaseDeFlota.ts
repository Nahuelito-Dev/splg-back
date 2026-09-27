import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CU-136 a CU-138: siembra los 4 planes base (seguro, VTV, licencia de
 * conducir, service) para las distribuidoras que ya existen. Las que se creen
 * de ahora en más los reciben solas, vía el evento `distribuidora.creada`
 * (ver `FleetPlanSeedListener`) — acá sólo se hace el backfill de las viejas.
 *
 * Idempotente: no duplica si una distribuidora ya tiene un plan con ese
 * nombre (por si el listener llegara a correr antes que esta migración).
 *
 * MISMOS valores que `fleet/domain/base-plans.ts`: si se cambia uno, se
 * cambia en los dos lados.
 */
export class SembrarPlanesBaseDeFlota1790473300000
  implements MigrationInterface
{
  name = 'SembrarPlanesBaseDeFlota1790473300000';

  private readonly nombresDeLosPlanesBase = [
    'Seguro del vehículo',
    'VTV',
    'Licencia de conducir',
    'Service / cambio de aceite',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "maintenance_plan"
        ("plan_id", "distributor_id", "name", "subject", "trigger", "interval_km", "interval_months", "lead_time_days", "criticality", "car_type", "is_active")
      SELECT
        uuid_generate_v4(), d."distributor_id", v.name, v.subject::"maintenance_subject_enum", v."trigger"::"maintenance_trigger_enum",
        v.interval_km, v.interval_months, v.lead_time_days, v.criticality::"maintenance_criticality_enum", NULL, true
      FROM "distributor" d
      CROSS JOIN (VALUES
        ('Seguro del vehículo', 'vehicle', 'by_fixed_date', NULL::integer, NULL::integer, 30, 'blocking'),
        ('VTV', 'vehicle', 'by_fixed_date', NULL::integer, NULL::integer, 30, 'blocking'),
        ('Licencia de conducir', 'driver', 'by_fixed_date', NULL::integer, NULL::integer, 30, 'blocking'),
        ('Service / cambio de aceite', 'vehicle', 'by_km', 10000, NULL::integer, 15, 'non_blocking')
      ) AS v(name, subject, "trigger", interval_km, interval_months, lead_time_days, criticality)
      WHERE NOT EXISTS (
        SELECT 1 FROM "maintenance_plan" mp
        WHERE mp."distributor_id" = d."distributor_id" AND mp."name" = v.name
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Si ya se crearon tareas contra alguno de estos planes, el FK RESTRICT
    // de maintenance_task.plan_id frena el DELETE: es el comportamiento
    // correcto (no se puede deshacer la siembra sin antes sacar las tareas).
    await queryRunner.query(
      `DELETE FROM "maintenance_plan" WHERE "name" = ANY($1)`,
      [this.nombresDeLosPlanesBase],
    );
  }
}
