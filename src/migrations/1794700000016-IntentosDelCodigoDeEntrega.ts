import { MigrationInterface, QueryRunner } from 'typeorm';

/** Contador de códigos de entrega incorrectos por pedido (bloqueo a los 5 intentos). */
export class IntentosDelCodigoDeEntrega1794700000016
  implements MigrationInterface
{
  name = 'IntentosDelCodigoDeEntrega1794700000016';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order" ADD "delivery_code_attempts" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD CONSTRAINT "CHK_order_intentos_codigo" CHECK ("delivery_code_attempts" >= 0)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order" DROP CONSTRAINT "CHK_order_intentos_codigo"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" DROP COLUMN "delivery_code_attempts"`,
    );
  }
}
