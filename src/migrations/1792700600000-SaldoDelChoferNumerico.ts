import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El saldo del chofer era `double precision`: acumulaba errores de redondeo en
 * cada ajuste. Pasa a `numeric(12,2)`, como el resto del dinero.
 */
export class SaldoDelChoferNumerico1792700600000 implements MigrationInterface {
  name = 'SaldoDelChoferNumerico1792700600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "delivery" ALTER COLUMN "balance" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "delivery" ALTER COLUMN "balance" TYPE numeric(12,2) USING round("balance"::numeric, 2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "delivery" ALTER COLUMN "balance" SET DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "delivery" ALTER COLUMN "balance" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "delivery" ALTER COLUMN "balance" TYPE double precision USING "balance"::double precision`,
    );
    await queryRunner.query(
      `ALTER TABLE "delivery" ALTER COLUMN "balance" SET DEFAULT 0`,
    );
  }
}
