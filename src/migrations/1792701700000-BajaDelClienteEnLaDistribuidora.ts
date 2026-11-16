import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * La distribuidora puede dar de baja a un cliente suyo sin tocar su cuenta ni
 * sus pedidos: `customer_distributor` guarda cuándo y quién (`removed_at`,
 * `removed_by_user_id`). Un CHECK impide registrar un autor sin baja.
 */
export class BajaDelClienteEnLaDistribuidora1792701700000
  implements MigrationInterface
{
  name = 'BajaDelClienteEnLaDistribuidora1792701700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "customer_distributor" ADD "removed_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_distributor" ADD "removed_by_user_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_distributor" ADD CONSTRAINT "FK_customer_distributor_removed_by" FOREIGN KEY ("removed_by_user_id") REFERENCES "user"("user_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_distributor" ADD CONSTRAINT "CHK_customer_distributor_baja" CHECK ("removed_by_user_id" IS NULL OR "removed_at" IS NOT NULL)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "customer_distributor" DROP CONSTRAINT "CHK_customer_distributor_baja"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_distributor" DROP CONSTRAINT "FK_customer_distributor_removed_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_distributor" DROP COLUMN "removed_by_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_distributor" DROP COLUMN "removed_at"`,
    );
  }
}
