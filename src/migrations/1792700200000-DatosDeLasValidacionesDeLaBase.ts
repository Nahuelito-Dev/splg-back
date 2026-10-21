import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Deja los datos que ya existen en condiciones de recibir las restricciones de
 * las migraciones siguientes:
 *  - los pedidos cancelados sin motivo quedan con «Sin motivo registrado»;
 *  - la prioridad de las zonas de cobertura activas pasa a ser única por
 *    distribuidora: donde se repetía se renumera de 0 a n-1 conservando quién
 *    gana hoy (mayor prioridad y, a igual prioridad, la zona de menor área;
 *    si también empatan, la más vieja y el id para que sea determinístico);
 *  - la patente de los vehículos queda en mayúsculas y sin espacios ni guiones.
 */
export class DatosDeLasValidacionesDeLaBase1792700200000
  implements MigrationInterface
{
  name = 'DatosDeLasValidacionesDeLaBase1792700200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "order"
          SET "cancellationReason" = 'Sin motivo registrado'
        WHERE "status" = 'cancelled'
          AND btrim(coalesce("cancellationReason", '')) = ''`,
    );
    await queryRunner.query(
      `UPDATE "order_status_history" h
          SET "reason" = 'Sin motivo registrado'
         FROM "order" o
        WHERE o."order_id" = h."order_id"
          AND h."to_status" = 'cancelled'
          AND btrim(coalesce(h."reason", '')) = ''
          AND o."cancellationReason" = 'Sin motivo registrado'`,
    );
    await queryRunner.query(
      `WITH repetidas AS (
         SELECT DISTINCT "distributor_id" FROM "coverage_zone"
          WHERE "isActive" AND "deletedAt" IS NULL
          GROUP BY "distributor_id", "priority" HAVING count(*) > 1
       ), ordenadas AS (
         SELECT z."coverage_zone_id",
                row_number() OVER (
                  PARTITION BY z."distributor_id"
                  ORDER BY z."priority" ASC, ST_Area(z."area") DESC,
                           z."createdAt" DESC, z."coverage_zone_id" DESC
                ) - 1 AS nueva
           FROM "coverage_zone" z
           JOIN repetidas r ON r."distributor_id" = z."distributor_id"
          WHERE z."isActive" AND z."deletedAt" IS NULL
       )
       UPDATE "coverage_zone" z SET "priority" = o."nueva"
         FROM ordenadas o WHERE o."coverage_zone_id" = z."coverage_zone_id"`,
    );
    await queryRunner.query(
      `UPDATE "car"
          SET "car_patent" = upper(regexp_replace("car_patent", '[[:space:]-]', '', 'g'))
        WHERE "car_patent" IS NOT NULL
          AND "car_patent" <> upper(regexp_replace("car_patent", '[[:space:]-]', '', 'g'))`,
    );
  }

  public async down(): Promise<void> {
    // Datos normalizados: no se pueden volver a los valores anteriores.
  }
}
