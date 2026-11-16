import { MigrationInterface, QueryRunner } from 'typeorm';

export class CalificacionModerada1791100200000 implements MigrationInterface {
  name = 'CalificacionModerada1791100200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "rating" ADD "hidden" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(`ALTER TABLE "rating" ADD "hidden_reason" text`);
    await queryRunner.query(
      `ALTER TABLE "rating" ADD "hidden_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "rating" ADD "hidden_by_user_id" uuid`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f5df1954571306276a5db7930f" ON "rating" ("hidden")`,
    );
    await queryRunner.query(
      `ALTER TABLE "rating" ADD CONSTRAINT "FK_3e5a121d120740dfd4ffa01164b" FOREIGN KEY ("hidden_by_user_id") REFERENCES "user"("user_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "rating" DROP CONSTRAINT "FK_3e5a121d120740dfd4ffa01164b"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f5df1954571306276a5db7930f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "rating" DROP COLUMN "hidden_by_user_id"`,
    );
    await queryRunner.query(`ALTER TABLE "rating" DROP COLUMN "hidden_at"`);
    await queryRunner.query(`ALTER TABLE "rating" DROP COLUMN "hidden_reason"`);
    await queryRunner.query(`ALTER TABLE "rating" DROP COLUMN "hidden"`);
  }
}
