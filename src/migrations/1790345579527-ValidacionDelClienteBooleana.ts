import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * customer.validated guardaba 'true'/'false' como texto (o null): un dominio
 * que admite cualquier cadena para un dato que sólo tiene dos valores. Pasa a
 * boolean NOT NULL DEFAULT false convirtiendo los datos en el lugar; un null
 * o cualquier texto que no sea 'true' queda como no validado.
 */
export class ValidacionDelClienteBooleana1790345579527
  implements MigrationInterface
{
  name = 'ValidacionDelClienteBooleana1790345579527';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "customer" ALTER COLUMN "validated" TYPE boolean USING ("validated" = 'true')`,
    );
    await queryRunner.query(
      `UPDATE "customer" SET "validated" = false WHERE "validated" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer" ALTER COLUMN "validated" SET DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer" ALTER COLUMN "validated" SET NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "customer" ALTER COLUMN "validated" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer" ALTER COLUMN "validated" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer" ALTER COLUMN "validated" TYPE text USING (CASE WHEN "validated" THEN 'true' ELSE 'false' END)`,
    );
  }
}
