import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Zonas de cobertura con recargo propio (fijo o porcentual) + snapshot de la
 * zona en el pedido.
 *
 * `coverage_zone.surcharge` ya era, en los hechos, un monto fijo (así lo usaba
 * `checkCoverage`, y `surcharge_type` default `fixed` desde que se agregó en
 * ModeloPropuesto): se RENOMBRA a `surcharge_value` sin tocar los datos. El
 * default de `surcharge_type` para las zonas NUEVAS pasa a `percentage`
 * (pedido del dueño: "tanto % más caro en Garupá"); las zonas que ya existen
 * no se tocan, siguen `fixed` con su monto de siempre.
 *
 * `order.subtotal_items` no tiene default: se agrega nullable, se llena con la
 * suma de `order_item.subtotal` de cada pedido (lo que YA es, para los
 * pedidos existentes, el subtotal antes de cualquier recargo) y recién ahí se
 * pone `NOT NULL`.
 */
export class ZonasConRecargo1790465283473 implements MigrationInterface {
  name = 'ZonasConRecargo1790465283473';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- coverage_zone --------------------------------------------------
    await queryRunner.query(
      `ALTER TABLE "coverage_zone" RENAME COLUMN "surcharge" TO "surcharge_value"`,
    );
    await queryRunner.query(
      `ALTER TABLE "coverage_zone" ADD "priority" integer NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `ALTER TABLE "coverage_zone" ADD "valid_from" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "coverage_zone" ALTER COLUMN "surcharge_type" SET DEFAULT 'percentage'`,
    );
    await queryRunner.query(
      `ALTER TABLE "coverage_zone" ADD CONSTRAINT "CHK_coverage_zone_surcharge" CHECK (("surcharge_type" = 'fixed' AND "surcharge_value" >= 0) OR ("surcharge_type" = 'percentage' AND "surcharge_value" >= 0 AND "surcharge_value" <= 100))`,
    );

    // --- order: snapshot de la zona al momento de pedir ------------------
    await queryRunner.query(`ALTER TABLE "order" ADD "coverage_zone_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "order" ADD "zone_name" character varying(120)`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."order_zone_surcharge_type_enum" AS ENUM('fixed', 'percentage')`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD "zone_surcharge_type" "public"."order_zone_surcharge_type_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD "zone_surcharge_value" numeric(10,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD "zone_surcharge_amount" numeric(10,2) NOT NULL DEFAULT '0'`,
    );

    // subtotal_items: nullable + backfill + NOT NULL (la tabla ya tiene filas).
    await queryRunner.query(
      `ALTER TABLE "order" ADD "subtotal_items" numeric(10,2)`,
    );
    await queryRunner.query(
      `UPDATE "order" o
          SET "subtotal_items" = COALESCE(
                (SELECT SUM(oi."subtotal") FROM "order_item" oi WHERE oi."order_id" = o."order_id"),
                0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ALTER COLUMN "subtotal_items" SET NOT NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE "order" ADD CONSTRAINT "FK_1ec11b9220a926133a2e15dad92" FOREIGN KEY ("coverage_zone_id") REFERENCES "coverage_zone"("coverage_zone_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order" DROP CONSTRAINT "FK_1ec11b9220a926133a2e15dad92"`,
    );
    await queryRunner.query(`ALTER TABLE "order" DROP COLUMN "subtotal_items"`);
    await queryRunner.query(
      `ALTER TABLE "order" DROP COLUMN "zone_surcharge_amount"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" DROP COLUMN "zone_surcharge_value"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" DROP COLUMN "zone_surcharge_type"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."order_zone_surcharge_type_enum"`,
    );
    await queryRunner.query(`ALTER TABLE "order" DROP COLUMN "zone_name"`);
    await queryRunner.query(
      `ALTER TABLE "order" DROP COLUMN "coverage_zone_id"`,
    );

    await queryRunner.query(
      `ALTER TABLE "coverage_zone" DROP CONSTRAINT "CHK_coverage_zone_surcharge"`,
    );
    await queryRunner.query(
      `ALTER TABLE "coverage_zone" ALTER COLUMN "surcharge_type" SET DEFAULT 'fixed'`,
    );
    await queryRunner.query(
      `ALTER TABLE "coverage_zone" DROP COLUMN "valid_from"`,
    );
    await queryRunner.query(
      `ALTER TABLE "coverage_zone" DROP COLUMN "priority"`,
    );
    await queryRunner.query(
      `ALTER TABLE "coverage_zone" RENAME COLUMN "surcharge_value" TO "surcharge"`,
    );
  }
}
