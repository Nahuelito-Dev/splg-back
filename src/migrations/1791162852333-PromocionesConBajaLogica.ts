import { MigrationInterface, QueryRunner } from 'typeorm';

export class PromocionesConBajaLogica1791162852333
  implements MigrationInterface
{
  name = 'PromocionesConBajaLogica1791162852333';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder_promotion" DROP CONSTRAINT "UQ_promocion_producto_cantidad"`,
    );
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder_promotion" ADD "deletedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_promocion_producto_cantidad" ON "gas_cylinder_promotion" ("gas_cylinder_id", "quantity") WHERE "deletedAt" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."UQ_promocion_producto_cantidad"`,
    );
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder_promotion" DROP COLUMN "deletedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder_promotion" ADD CONSTRAINT "UQ_promocion_producto_cantidad" UNIQUE ("gas_cylinder_id", "quantity")`,
    );
  }
}
