import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cada pago guarda con qué cuenta de Mercado Pago se cobró (`credential_id`;
 * null = la del sistema), y una distribuidora puede tener varias credenciales
 * (las reemplazadas quedan desactivadas) con una sola activa.
 */
export class CuentaDeMercadoPagoEnElPago1794600000002
  implements MigrationInterface
{
  name = 'CuentaDeMercadoPagoEnElPago1794600000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "distributor_mercadopago_credentials" DROP CONSTRAINT "UQ_distributor_mp_credentials_distributor"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_distributor_mp_credentials_activa" ON "distributor_mercadopago_credentials" ("distributor_id") WHERE "active" = true`,
    );
    await queryRunner.query(`ALTER TABLE "payment" ADD "credential_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "payment" ADD CONSTRAINT "FK_1b1eba74563e2d917be8196a5a8" FOREIGN KEY ("credential_id") REFERENCES "distributor_mercadopago_credentials"("credential_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payment" DROP CONSTRAINT "FK_1b1eba74563e2d917be8196a5a8"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment" DROP COLUMN "credential_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_distributor_mp_credentials_activa"`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor_mercadopago_credentials" ADD CONSTRAINT "UQ_distributor_mp_credentials_distributor" UNIQUE ("distributor_id")`,
    );
  }
}
