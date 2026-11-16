import { MigrationInterface, QueryRunner } from 'typeorm';

export class PrecioDelEnvase1795000000010 implements MigrationInterface {
  name = 'PrecioDelEnvase1795000000010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder" ADD "container_price" numeric(12,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder" ADD CONSTRAINT "CHK_gas_cylinder_precio_envase" CHECK ("container_price" IS NULL OR "container_price" > 0)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder" DROP CONSTRAINT "CHK_gas_cylinder_precio_envase"`,
    );
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder" DROP COLUMN "container_price"`,
    );
  }
}
