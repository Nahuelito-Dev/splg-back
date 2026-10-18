import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * C-17 (correcciones): `payment_refund.refunded_baseline` guarda lo que la pasarela
 * ya había devuelto antes del último intento, para decidir si un intento cortado
 * (timeout, caída del proceso) se aplicó.
 */
export class ReintegrosResiliencia1792300000000 implements MigrationInterface {
  name = 'ReintegrosResiliencia1792300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payment_refund" ADD "refunded_baseline" numeric(10,2)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payment_refund" DROP COLUMN "refunded_baseline"`,
    );
  }
}
