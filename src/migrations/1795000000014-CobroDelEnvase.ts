import { MigrationInterface, QueryRunner } from 'typeorm';

export class CobroDelEnvase1795000000014 implements MigrationInterface {
  name = 'CobroDelEnvase1795000000014';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order_item" ADD "containers_charged" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_item" ADD "container_unit_price" numeric(12,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_item" ADD CONSTRAINT "CHK_order_item_envases_cobrados" CHECK ("containers_charged" >= 0 AND "containers_charged" <= "quantity" AND ("containers_charged" = 0 OR "container_unit_price" > 0))`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD "container_charge_amount" numeric(12,2) NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD CONSTRAINT "CHK_order_cargo_envases" CHECK ("container_charge_amount" >= 0)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order" DROP CONSTRAINT "CHK_order_cargo_envases"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" DROP COLUMN "container_charge_amount"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_item" DROP CONSTRAINT "CHK_order_item_envases_cobrados"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_item" DROP COLUMN "container_unit_price"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_item" DROP COLUMN "containers_charged"`,
    );
  }
}
