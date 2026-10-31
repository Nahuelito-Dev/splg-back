import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cuenta de Mercado Pago propia de cada distribuidora: access token, clave
 * pública y secreto del webhook, los tres cifrados por la aplicación. Una fila
 * por distribuidora; `active = false` devuelve el cobro a la cuenta del sistema.
 */
export class CredencialesMercadoPagoPorDistribuidora1794600000000
  implements MigrationInterface
{
  name = 'CredencialesMercadoPagoPorDistribuidora1794600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "distributor_mercadopago_credentials" ("credential_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "access_token_encrypted" text NOT NULL, "public_key_encrypted" text NOT NULL, "webhook_secret_encrypted" text NOT NULL, "active" boolean NOT NULL DEFAULT true, "loaded_by_user_id" uuid NOT NULL, "verified_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_distributor_mp_credentials_distributor" UNIQUE ("distributor_id"), CONSTRAINT "CHK_distributor_mp_credentials_cifradas" CHECK ("access_token_encrypted" <> '' AND "public_key_encrypted" <> '' AND "webhook_secret_encrypted" <> ''), CONSTRAINT "PK_9bd84061d64bb6e2b2097a13dd1" PRIMARY KEY ("credential_id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor_mercadopago_credentials" ADD CONSTRAINT "FK_f32f9faafe561b49d51bed551ff" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor_mercadopago_credentials" ADD CONSTRAINT "FK_d0a230de3d9ee122d2e134a3cf5" FOREIGN KEY ("loaded_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "distributor_mercadopago_credentials" DROP CONSTRAINT "FK_d0a230de3d9ee122d2e134a3cf5"`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor_mercadopago_credentials" DROP CONSTRAINT "FK_f32f9faafe561b49d51bed551ff"`,
    );
    await queryRunner.query(`DROP TABLE "distributor_mercadopago_credentials"`);
  }
}
