import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Caja completa, etapa 3 (API v2): lo que se cobra por las ventas entra a una
 * caja. Usa los valores de enum de `IngresosDeVentasEnumsDeCaja`.
 *
 * - `cash_collection_settings`: la caja de Mercado Pago (billetera) y la de
 *   transferencias (banco) de cada distribuidora. Clave foránea compuesta con la
 *   distribuidora y un disparador que exige la clase de cada caja.
 * - `payment.approved_at`: cuándo se aprobó el cobro; los ya aprobados la toman
 *   de su última actualización.
 * - `UQ_cash_movement_cobro_de_venta`: un cobro, una comisión, una devolución o
 *   una transferencia se asientan una sola vez, aunque el webhook llegue repetido.
 * - Siembra las dos categorías de sistema en las distribuidoras existentes.
 */
export class IngresosDeVentas1794000000001 implements MigrationInterface {
  name = 'IngresosDeVentas1794000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const sql = (texto: string) => queryRunner.query(texto);

    await sql(
      `CREATE TABLE "cash_collection_settings" ("distributor_id" uuid NOT NULL, "mercadopago_cash_box_id" uuid, "transfer_cash_box_id" uuid, "updated_by_user_id" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_cash_collection_settings" PRIMARY KEY ("distributor_id"))`,
    );
    await sql(
      `ALTER TABLE "cash_collection_settings" ADD CONSTRAINT "FK_cash_collection_settings_distributor" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await sql(
      `ALTER TABLE "cash_collection_settings" ADD CONSTRAINT "FK_cash_collection_settings_updated_by" FOREIGN KEY ("updated_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await sql(
      `ALTER TABLE "cash_collection_settings" ADD CONSTRAINT "FK_cash_collection_settings_mercadopago_cash_box_distribuidora" FOREIGN KEY ("mercadopago_cash_box_id", "distributor_id") REFERENCES "cash_box"("cash_box_id","distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await sql(
      `ALTER TABLE "cash_collection_settings" ADD CONSTRAINT "FK_cash_collection_settings_transfer_cash_box_distribuidora" FOREIGN KEY ("transfer_cash_box_id", "distributor_id") REFERENCES "cash_box"("cash_box_id","distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await sql(`
      CREATE FUNCTION "cash_collection_settings_clase"() RETURNS trigger AS $$
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
      `CREATE TRIGGER "TRG_cash_collection_settings_clase" BEFORE INSERT OR UPDATE ON "cash_collection_settings" FOR EACH ROW EXECUTE FUNCTION "cash_collection_settings_clase"()`,
    );

    await sql(
      `ALTER TABLE "payment" ADD "approved_at" TIMESTAMP WITH TIME ZONE`,
    );
    await sql(
      `UPDATE "payment" SET "approved_at" = "updatedAt" WHERE "status" IN ('approved', 'refunded')`,
    );

    await sql(
      `CREATE UNIQUE INDEX "UQ_cash_movement_cobro_de_venta" ON "cash_movement" ("reference_type", "reference_id") WHERE "reference_type" IN ('payment', 'payment_fee', 'payment_refund', 'order_transfer')`,
    );

    await sql(`
      INSERT INTO "cash_category" ("distributor_id", "name", "direction", "system_code")
      SELECT d."distributor_id", c."name", c."direction"::"public"."cash_category_direction_enum", c."code"::"public"."cash_category_system_code_enum"
      FROM "distributor" d
      CROSS JOIN (VALUES
        ('Comisiones de Mercado Pago', 'expense', 'mercadopago_fee'),
        ('Devoluciones a clientes', 'expense', 'customer_refund')
      ) AS c("name", "direction", "code")
      WHERE NOT EXISTS (
        SELECT 1 FROM "cash_category" x
        WHERE x."distributor_id" = d."distributor_id" AND x."system_code"::text = c."code"
      )
    `);
  }

  /** Aborta si hay cobros de ventas asentados: esa historia no se descarta sola. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const filas: unknown = await queryRunner.query(
      `SELECT count(*) AS movimientos FROM "cash_movement"
       WHERE "reference_type" IN ('payment', 'payment_fee', 'payment_refund', 'order_transfer')`,
    );
    const { movimientos } = (filas as Array<{ movimientos: string }>)[0];
    if (Number(movimientos) > 0) {
      throw new Error(
        `No se puede revertir: hay ${movimientos} movimientos de caja de cobros de ventas`,
      );
    }
    const sql = (texto: string) => queryRunner.query(texto);
    await sql(`DROP INDEX "UQ_cash_movement_cobro_de_venta"`);
    await sql(`ALTER TABLE "payment" DROP COLUMN "approved_at"`);
    await sql(
      `DROP TRIGGER "TRG_cash_collection_settings_clase" ON "cash_collection_settings"`,
    );
    await sql(`DROP FUNCTION "cash_collection_settings_clase"()`);
    await sql(`DROP TABLE "cash_collection_settings"`);
  }
}
