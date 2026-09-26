import { MigrationInterface, QueryRunner } from 'typeorm';

export class BajaLogica1790345335671 implements MigrationInterface {
  name = 'BajaLogica1790345335671';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "car" ADD "deletedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_address" ADD "deletedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "coverage_zone" ADD "deletedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "car" DROP CONSTRAINT "UQ_81fec581f526499deff9677050e"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_car_patente_vigente" ON "car" ("car_patent") WHERE "deletedAt" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."UQ_car_patente_vigente"`);
    await queryRunner.query(
      `ALTER TABLE "car" ADD CONSTRAINT "UQ_81fec581f526499deff9677050e" UNIQUE ("car_patent")`,
    );
    await queryRunner.query(
      `ALTER TABLE "coverage_zone" DROP COLUMN "deletedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_address" DROP COLUMN "deletedAt"`,
    );
    await queryRunner.query(`ALTER TABLE "car" DROP COLUMN "deletedAt"`);
  }
}
