import { MigrationInterface, QueryRunner } from 'typeorm';

export class IncidenciaDescartada1791100100000 implements MigrationInterface {
  name = 'IncidenciaDescartada1791100100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."incident_status_enum" ADD VALUE IF NOT EXISTS 'discarded'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const filas: unknown = await queryRunner.query(
      `SELECT count(*) AS n FROM "incident" WHERE "status" = 'discarded'`,
    );
    if (Number((filas as Array<{ n: string }>)[0].n) > 0) {
      throw new Error(
        'No se puede revertir: hay incidencias en estado "discarded"',
      );
    }
    await queryRunner.query(
      `ALTER TYPE "public"."incident_status_enum" RENAME TO "incident_status_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."incident_status_enum" AS ENUM('open', 'resolved')`,
    );
    await queryRunner.query(
      `ALTER TABLE "incident" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "incident" ALTER COLUMN "status" TYPE "public"."incident_status_enum" USING "status"::text::"public"."incident_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "incident" ALTER COLUMN "status" SET DEFAULT 'open'`,
    );
    await queryRunner.query(`DROP TYPE "public"."incident_status_enum_old"`);
  }
}
