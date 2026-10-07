import { MigrationInterface, QueryRunner } from 'typeorm';

export class RolBajaLogica1791100400000 implements MigrationInterface {
  name = 'RolBajaLogica1791100400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "role" ADD "deletedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "role" DROP CONSTRAINT "UQ_9a0c91c218a16e604951ff1c099"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_role_type_vigente" ON "role" ("type") WHERE "deletedAt" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."UQ_role_type_vigente"`);
    await queryRunner.query(
      `DELETE FROM "role" WHERE "deletedAt" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "user" u WHERE u."role_id" = "role"."role_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "role" ADD CONSTRAINT "UQ_9a0c91c218a16e604951ff1c099" UNIQUE ("type")`,
    );
    await queryRunner.query(`ALTER TABLE "role" DROP COLUMN "deletedAt"`);
  }
}
