import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backfill de "vehículo en uso" (revisión del 01/10, punto 1 — ALTA): antes
 * de esta tanda no existía el concepto de asignación, así que todos los
 * choferes arrancarían el 01/10 sin vehículo en uso aunque vinieran
 * manejando el mismo auto hace meses (`car.user_id`). Para no obligar a
 * reasignar manualmente a toda la flota, esta migración abre una asignación
 * inicial para cada chofer vigente que tiene EXACTAMENTE un vehículo
 * vigente con `car.user_id` apuntándole, y ese vehículo está libre (nadie lo
 * tiene abierto todavía — siempre cierto en un deploy nuevo, pero se chequea
 * por si esta migración corriera después de que la app ya esté en uso).
 *
 * A los demás (sin vehículo propio, o con más de uno) NO se les asigna nada:
 * el panel los va a mostrar "sin vehículo asignado" y un admin elige a mano
 * cuál es el correcto — no hay forma de adivinarlo sin ambigüedad, y
 * `nahue` decidió explícitamente no inventar una regla para ese caso.
 *
 * `assigned_by_user_id` se relaja a NULLable (nadie lo asignó: lo infirió el
 * sistema) — sólo estas filas del backfill quedan con `NULL` ahí; todo lo
 * que se asigna por la API siempre tiene un admin o chofer real.
 *
 * Sólo agrega/relaja: ninguna fila existente se borra ni se vuelve más
 * restrictiva. Es re-corrible sin duplicar (los `NOT EXISTS`/`WHERE` dejan
 * afuera a quien ya tenga algo abierto).
 */
export class BackfillVehiculoEnUsoInicial1790826300000
  implements MigrationInterface
{
  name = 'BackfillVehiculoEnUsoInicial1790826300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "vehicle_assignment" ALTER COLUMN "assigned_by_user_id" DROP NOT NULL`,
    );

    await queryRunner.query(`
      INSERT INTO "vehicle_assignment" (
        "distributor_id", "car_id", "delivery_id", "assigned_at",
        "released_at", "assigned_by_user_id", "released_by_user_id", "note"
      )
      SELECT
        d.distributor_id,
        c.car_id,
        d.delivery_id,
        now(),
        NULL,
        NULL,
        NULL,
        'Asignación inicial (backfill de vehículo en uso)'
      FROM "delivery" d
      JOIN "user" u ON u.user_id = d.user_id AND u."deletedAt" IS NULL
      JOIN "car" c ON c.user_id = d.user_id
        AND c."deletedAt" IS NULL
        AND c.distributor_id = d.distributor_id
      WHERE d."deletedAt" IS NULL
        AND (
          SELECT COUNT(*) FROM "car" c2
          WHERE c2.user_id = d.user_id AND c2."deletedAt" IS NULL
        ) = 1
        AND NOT EXISTS (
          SELECT 1 FROM "vehicle_assignment" va
          WHERE va.car_id = c.car_id AND va.released_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM "vehicle_assignment" va2
          WHERE va2.delivery_id = d.delivery_id AND va2.released_at IS NULL
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Sólo las filas que generó ESTE backfill (la nota es el marcador):
    // nunca una asignación real, que siempre tiene `assigned_by_user_id`.
    await queryRunner.query(
      `DELETE FROM "vehicle_assignment"
       WHERE "assigned_by_user_id" IS NULL
         AND "note" = 'Asignación inicial (backfill de vehículo en uso)'`,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicle_assignment" ALTER COLUMN "assigned_by_user_id" SET NOT NULL`,
    );
  }
}
