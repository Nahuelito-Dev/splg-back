import { MigrationInterface, QueryRunner } from 'typeorm';

export class StockConciliacion1791750558774 implements MigrationInterface {
  name = 'StockConciliacion1791750558774';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "stock_reconciliation_alert" ("distributor_id" uuid NOT NULL, "signature" character varying(64) NOT NULL, "alerted_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_stock_reconciliation_alert" PRIMARY KEY ("distributor_id"))`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."stock_adjustment_reason_enum" RENAME TO "stock_adjustment_reason_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."stock_adjustment_reason_enum" AS ENUM('count_correction', 'shrinkage', 'leak', 'damaged', 'lost', 'found', 'initial_count', 'reconciliation')`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustment" ALTER COLUMN "reason" TYPE "public"."stock_adjustment_reason_enum" USING "reason"::"text"::"public"."stock_adjustment_reason_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."stock_adjustment_reason_enum_old"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_reconciliation_alert" ADD CONSTRAINT "FK_stock_reconciliation_alert_distributor" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "stock_reconciliation_alert" DROP CONSTRAINT "FK_stock_reconciliation_alert_distributor"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."stock_adjustment_reason_enum_old" AS ENUM('count_correction', 'shrinkage', 'leak', 'damaged', 'lost', 'found', 'initial_count')`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustment" ALTER COLUMN "reason" TYPE "public"."stock_adjustment_reason_enum_old" USING "reason"::"text"::"public"."stock_adjustment_reason_enum_old"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."stock_adjustment_reason_enum"`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."stock_adjustment_reason_enum_old" RENAME TO "stock_adjustment_reason_enum"`,
    );
    await queryRunner.query(`DROP TABLE "stock_reconciliation_alert"`);
  }
}
