import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Deja los datos que ya existen en condiciones de recibir las restricciones de
 * las migraciones siguientes:
 *  - los pedidos cancelados sin motivo quedan con «Sin motivo registrado»;
 *  - la prioridad de las zonas de cobertura activas pasa a ser única por
 *    distribuidora: donde se repetía se renumera de 0 a n-1 conservando quién
 *    gana hoy (mayor prioridad y, a igual prioridad, la zona de menor área;
 *    si también empatan, la más vieja y el id para que sea determinístico);
 *  - la patente de los vehículos queda en mayúsculas y sin espacios ni guiones;
 *  - las ofertas de despacho: de las constancias `accepted` de un mismo pedido
 *    (el chofer lo liberó y otro lo retomó) sólo la más reciente sigue aceptada,
 *    las anteriores pasan a `rejected`, como lo escribe hoy el back al liberar; y una oferta con `expiresAt` igual o
 *    anterior a `offeredAt` (constancias manuales) vence un segundo después de
 *    ofrecerse. Son las filas que rechazarían `UQ_order_dispatch_offer_aceptada`
 *    y `CHK_order_dispatch_offer_vencimiento`.
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
    // Igual que las escrituras nuevas (el chofer que sostuvo y liberó el pedido
    // queda como rechazado): sigue bloqueado y no se le vuelve a ofrecer.
    await queryRunner.query(
      `UPDATE "order_dispatch_offer" o SET "status" = 'rejected'
        WHERE o."status" = 'accepted'
          AND EXISTS (
            SELECT 1 FROM "order_dispatch_offer" n
             WHERE n."order_id" = o."order_id" AND n."status" = 'accepted'
               AND (n."offeredAt", n."offer_id") > (o."offeredAt", o."offer_id"))`,
    );
    await queryRunner.query(
      `UPDATE "order_dispatch_offer"
          SET "expiresAt" = "offeredAt" + interval '1 second'
        WHERE "expiresAt" <= "offeredAt"`,
    );
  }

  public async down(): Promise<void> {
    // Datos normalizados: no se pueden volver a los valores anteriores.
  }
}
