import { MigrationInterface, QueryRunner } from 'typeorm';

export class BlindajeStock1791930000000 implements MigrationInterface {
  name = 'BlindajeStock1791930000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder" ADD "reservation_deficit" integer NOT NULL DEFAULT '0'`,
    );
    // Lo que hoy las reservas de pedidos abiertos superan al físico: es el
    // déficit con el que el vendible (en cero) y el físico cierran.
    await queryRunner.query(
      `UPDATE "gas_cylinder" g
       SET "reservation_deficit" = d."deficit"
       FROM (
         SELECT g2."gas_cylinder_id",
                GREATEST(0, COALESCE(r."reservado", 0) - COALESCE(f."fisico", 0)) AS "deficit"
         FROM "gas_cylinder" g2
         LEFT JOIN (
           SELECT i."gas_cylinder_id", SUM(i."quantity") AS "reservado"
           FROM "order_item" i
           JOIN "order" o ON o."order_id" = i."order_id"
           WHERE o."status"::text IN ('reserved', 'pending', 'accepted', 'on_the_way')
           GROUP BY i."gas_cylinder_id"
         ) r ON r."gas_cylinder_id" = g2."gas_cylinder_id"
         LEFT JOIN (
           SELECT "gas_cylinder_id", SUM("quantity") AS "fisico"
           FROM "stock_balance" WHERE "condition" = 'full'
           GROUP BY "gas_cylinder_id"
         ) f ON f."gas_cylinder_id" = g2."gas_cylinder_id"
       ) d
       WHERE g."gas_cylinder_id" = d."gas_cylinder_id" AND d."deficit" > 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_receipt_item" ADD "previous_on_hand_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_stock_movement_alta" ON "stock_movement" ("distributor_id", "createdAt") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_stock_movement_alta"`);
    await queryRunner.query(
      `ALTER TABLE "purchase_receipt_item" DROP COLUMN "previous_on_hand_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder" DROP COLUMN "reservation_deficit"`,
    );
  }
}
