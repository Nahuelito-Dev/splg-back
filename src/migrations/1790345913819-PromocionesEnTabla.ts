import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Normalización (1FN): las promociones por volumen eran un arreglo JSON dentro
 * de gas_cylinder, un grupo repetitivo que la base no podía validar. Pasan a
 * su tabla, con unicidad por producto y cantidad y los rangos como CHECK.
 */
export class PromocionesEnTabla1790345913819 implements MigrationInterface {
  name = 'PromocionesEnTabla1790345913819';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "gas_cylinder_promotion" ("promotion_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "gas_cylinder_id" uuid NOT NULL, "quantity" integer NOT NULL, "discount_percentage" numeric(5,2) NOT NULL, CONSTRAINT "UQ_promocion_producto_cantidad" UNIQUE ("gas_cylinder_id", "quantity"), CONSTRAINT "CHK_promocion_descuento" CHECK ("discount_percentage" > 0 AND "discount_percentage" <= 100), CONSTRAINT "CHK_promocion_cantidad" CHECK ("quantity" >= 2), CONSTRAINT "PK_cf52f52e1b6843b4de1496556b1" PRIMARY KEY ("promotion_id"))`,
    );
    // Cada elemento del arreglo JSON pasa a ser una fila (8 en la base de
    // desarrollo, todas dentro de los rangos que ahora valida la tabla).
    await queryRunner.query(
      `INSERT INTO "gas_cylinder_promotion" ("gas_cylinder_id", "quantity", "discount_percentage")
       SELECT g."gas_cylinder_id", (e->>'quantity')::int, (e->>'discountPercentage')::numeric
         FROM "gas_cylinder" g, jsonb_array_elements(coalesce(g."promotions", '[]'::jsonb)) e`,
    );
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder" DROP COLUMN "promotions"`,
    );
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder_promotion" ADD CONSTRAINT "FK_0a42c125880d87457584a8155d1" FOREIGN KEY ("gas_cylinder_id") REFERENCES "gas_cylinder"("gas_cylinder_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder_promotion" DROP CONSTRAINT "FK_0a42c125880d87457584a8155d1"`,
    );
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder" ADD "promotions" jsonb`,
    );
    await queryRunner.query(
      `UPDATE "gas_cylinder" g SET "promotions" = p.arreglo
         FROM (SELECT "gas_cylinder_id",
                      jsonb_agg(jsonb_build_object('quantity', "quantity", 'discountPercentage', "discount_percentage") ORDER BY "quantity") AS arreglo
                 FROM "gas_cylinder_promotion" GROUP BY "gas_cylinder_id") p
        WHERE p."gas_cylinder_id" = g."gas_cylinder_id"`,
    );
    await queryRunner.query(`DROP TABLE "gas_cylinder_promotion"`);
  }
}
