import { MigrationInterface, QueryRunner } from 'typeorm';

const CBU_VALIDO = `"bank_cbu" IS NULL OR CASE WHEN "bank_cbu" ~ '^[0-9]{22}$' THEN (10 - ((substr("bank_cbu", 1, 1)::int * 7 + substr("bank_cbu", 2, 1)::int * 1 + substr("bank_cbu", 3, 1)::int * 3 + substr("bank_cbu", 4, 1)::int * 9 + substr("bank_cbu", 5, 1)::int * 7 + substr("bank_cbu", 6, 1)::int * 1 + substr("bank_cbu", 7, 1)::int * 3) % 10)) % 10 = substr("bank_cbu", 8, 1)::int AND (10 - ((substr("bank_cbu", 9, 1)::int * 3 + substr("bank_cbu", 10, 1)::int * 9 + substr("bank_cbu", 11, 1)::int * 7 + substr("bank_cbu", 12, 1)::int * 1 + substr("bank_cbu", 13, 1)::int * 3 + substr("bank_cbu", 14, 1)::int * 9 + substr("bank_cbu", 15, 1)::int * 7 + substr("bank_cbu", 16, 1)::int * 1 + substr("bank_cbu", 17, 1)::int * 3 + substr("bank_cbu", 18, 1)::int * 9 + substr("bank_cbu", 19, 1)::int * 7 + substr("bank_cbu", 20, 1)::int * 1 + substr("bank_cbu", 21, 1)::int * 3) % 10)) % 10 = substr("bank_cbu", 22, 1)::int ELSE false END`;

/**
 * La transferencia deja de existir como forma de cobro: se quitan los datos
 * bancarios de la distribuidora (CBU, alias, titular y sus restricciones) y la
 * caja de transferencias de las cajas de cobro (columna, clave foránea y la
 * validación de clase del disparador). Los pedidos y movimientos históricos no se
 * tocan.
 *
 * `down` recrea las columnas, sus restricciones (CBU, alias y titular) y la
 * validación de clase sin datos: lo borrado no vuelve.
 */
export class QuitarDatosBancariosYCajaDeTransferencias1795000000170
  implements MigrationInterface
{
  name = 'QuitarDatosBancariosYCajaDeTransferencias1795000000170';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const sql = (texto: string) => queryRunner.query(texto);

    await sql(
      `ALTER TABLE "distributor" DROP CONSTRAINT IF EXISTS "CHK_distributor_cbu"`,
    );
    await sql(
      `ALTER TABLE "distributor" DROP CONSTRAINT IF EXISTS "CHK_distributor_alias"`,
    );
    await sql(
      `ALTER TABLE "distributor" DROP CONSTRAINT IF EXISTS "CHK_distributor_titular"`,
    );
    await sql(`ALTER TABLE "distributor" DROP COLUMN "bank_cbu"`);
    await sql(`ALTER TABLE "distributor" DROP COLUMN "bank_alias"`);
    await sql(`ALTER TABLE "distributor" DROP COLUMN "bank_holder"`);

    await sql(
      `ALTER TABLE "cash_collection_settings" DROP CONSTRAINT "FK_cash_collection_settings_transfer_cash_box_distribuidora"`,
    );
    await sql(
      `ALTER TABLE "cash_collection_settings" DROP COLUMN "transfer_cash_box_id"`,
    );
    await sql(`
      CREATE OR REPLACE FUNCTION "cash_collection_settings_clase"() RETURNS trigger AS $$
      BEGIN
        IF NEW."mercadopago_cash_box_id" IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM "cash_box" WHERE "cash_box_id" = NEW."mercadopago_cash_box_id" AND "kind" = 'wallet'
        ) THEN
          RAISE EXCEPTION 'La caja de Mercado Pago tiene que ser una billetera'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'CHK_cash_collection_settings_mercadopago_billetera';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const sql = (texto: string) => queryRunner.query(texto);

    await sql(
      `ALTER TABLE "cash_collection_settings" ADD "transfer_cash_box_id" uuid`,
    );
    await sql(
      `ALTER TABLE "cash_collection_settings" ADD CONSTRAINT "FK_cash_collection_settings_transfer_cash_box_distribuidora" FOREIGN KEY ("transfer_cash_box_id", "distributor_id") REFERENCES "cash_box"("cash_box_id","distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await sql(`
      CREATE OR REPLACE FUNCTION "cash_collection_settings_clase"() RETURNS trigger AS $$
      BEGIN
        IF NEW."mercadopago_cash_box_id" IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM "cash_box" WHERE "cash_box_id" = NEW."mercadopago_cash_box_id" AND "kind" = 'wallet'
        ) THEN
          RAISE EXCEPTION 'La caja de Mercado Pago tiene que ser una billetera'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'CHK_cash_collection_settings_mercadopago_billetera';
        END IF;
        IF NEW."transfer_cash_box_id" IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM "cash_box" WHERE "cash_box_id" = NEW."transfer_cash_box_id" AND "kind" = 'bank'
        ) THEN
          RAISE EXCEPTION 'La caja de transferencias tiene que ser una cuenta de banco'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'CHK_cash_collection_settings_transferencia_banco';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await sql(`ALTER TABLE "distributor" ADD "bank_cbu" character varying(22)`);
    await sql(
      `ALTER TABLE "distributor" ADD "bank_alias" character varying(20)`,
    );
    await sql(
      `ALTER TABLE "distributor" ADD "bank_holder" character varying(120)`,
    );
    await sql(
      `ALTER TABLE "distributor" ADD CONSTRAINT "CHK_distributor_cbu" CHECK (${CBU_VALIDO})`,
    );
    await sql(
      `ALTER TABLE "distributor" ADD CONSTRAINT "CHK_distributor_alias" CHECK ("bank_alias" IS NULL OR "bank_alias" ~ '^[A-Za-z0-9.-]{6,20}$')`,
    );
    await sql(
      `ALTER TABLE "distributor" ADD CONSTRAINT "CHK_distributor_titular" CHECK ("bank_holder" IS NULL OR char_length(btrim("bank_holder")) >= 2)`,
    );
  }
}
