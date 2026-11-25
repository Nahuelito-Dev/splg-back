import { MigrationInterface, QueryRunner } from 'typeorm';

const CBU_VALIDO = `"bank_cbu" IS NULL OR CASE WHEN "bank_cbu" ~ '^[0-9]{22}$' THEN (10 - ((substr("bank_cbu", 1, 1)::int * 7 + substr("bank_cbu", 2, 1)::int * 1 + substr("bank_cbu", 3, 1)::int * 3 + substr("bank_cbu", 4, 1)::int * 9 + substr("bank_cbu", 5, 1)::int * 7 + substr("bank_cbu", 6, 1)::int * 1 + substr("bank_cbu", 7, 1)::int * 3) % 10)) % 10 = substr("bank_cbu", 8, 1)::int AND (10 - ((substr("bank_cbu", 9, 1)::int * 3 + substr("bank_cbu", 10, 1)::int * 9 + substr("bank_cbu", 11, 1)::int * 7 + substr("bank_cbu", 12, 1)::int * 1 + substr("bank_cbu", 13, 1)::int * 3 + substr("bank_cbu", 14, 1)::int * 9 + substr("bank_cbu", 15, 1)::int * 7 + substr("bank_cbu", 16, 1)::int * 1 + substr("bank_cbu", 17, 1)::int * 3 + substr("bank_cbu", 18, 1)::int * 9 + substr("bank_cbu", 19, 1)::int * 7 + substr("bank_cbu", 20, 1)::int * 1 + substr("bank_cbu", 21, 1)::int * 3) % 10)) % 10 = substr("bank_cbu", 22, 1)::int ELSE false END`;

/**
 * La transferencia deja de existir como forma de cobro, pero no se borra nada:
 * los datos bancarios de la distribuidora (`bank_cbu`, `bank_alias`,
 * `bank_holder`) y la caja de transferencias (`transfer_cash_box_id`, con su
 * clave foránea) quedan en la base, sin uso. Se quitan sólo las restricciones
 * que obligaban a cargarlos bien (CBU, alias y titular) y la validación de
 * clase de la caja de transferencias del disparador. Los pedidos y movimientos
 * históricos no se tocan.
 *
 * `down` vuelve a poner esas restricciones y la validación de clase.
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
