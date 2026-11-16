import { MigrationInterface, QueryRunner } from 'typeorm';

export class VaciasRecibidasEnLaEntrega1795000000018
  implements MigrationInterface
{
  name = 'VaciasRecibidasEnLaEntrega1795000000018';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order_item" ADD "empties_received" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_item" ADD CONSTRAINT "CHK_order_item_vacias_recibidas" CHECK ("empties_received" IS NULL OR ("empties_received" >= 0 AND "empties_received" <= "quantity" - "containers_charged"))`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order_item" DROP CONSTRAINT "CHK_order_item_vacias_recibidas"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_item" DROP COLUMN "empties_received"`,
    );
  }
}
