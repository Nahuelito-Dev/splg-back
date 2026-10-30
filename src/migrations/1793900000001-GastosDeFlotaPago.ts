import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Caja completa, etapa 2 (API v2): el pago de los gastos de la flota y de las
 * compras sale de una caja. Usa los valores de enum de `GastosDeFlotaEnumsDeCaja`.
 *
 * - `maintenance_task`, `tire`, `vehicle_accident` (pago y reintegro) llevan la
 *   salida (o entrada) de caja y la fecha; `fuel_load` y `purchase_receipt`, que
 *   ya tenían la salida, ganan la fecha (`paid_at`, completada desde el
 *   movimiento de los que ya estaban pagos).
 * - Claves foráneas compuestas con la distribuidora, como las demás, y CHECK de
 *   que el pago está completo o no está.
 * - Siembra las cuatro categorías de sistema en las distribuidoras existentes.
 */
export class GastosDeFlotaPago1793900000001 implements MigrationInterface {
  name = 'GastosDeFlotaPago1793900000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const sql = (texto: string) => queryRunner.query(texto);

    await sql(
      `ALTER TABLE "maintenance_task" ADD "cash_movement_id" uuid, ADD "paid_at" TIMESTAMP WITH TIME ZONE, ADD "paid_amount" numeric(10,2)`,
    );
    await sql(
      `ALTER TABLE "tire" ADD "cash_movement_id" uuid, ADD "paid_at" TIMESTAMP WITH TIME ZONE`,
    );
    await sql(
      `ALTER TABLE "vehicle_accident" ADD "payment_cash_movement_id" uuid, ADD "payment_paid_at" TIMESTAMP WITH TIME ZONE, ADD "payment_amount" numeric(12,2), ADD "reimbursement_cash_movement_id" uuid, ADD "reimbursement_received_at" TIMESTAMP WITH TIME ZONE, ADD "reimbursement_amount" numeric(12,2)`,
    );
    await sql(`ALTER TABLE "fuel_load" ADD "paid_at" TIMESTAMP WITH TIME ZONE`);
    await sql(
      `ALTER TABLE "purchase_receipt" ADD "paid_at" TIMESTAMP WITH TIME ZONE`,
    );

    await sql(
      `UPDATE "fuel_load" f SET "paid_at" = m."occurred_at" FROM "cash_movement" m WHERE f."cash_movement_id" = m."movement_id"`,
    );
    await sql(
      `UPDATE "purchase_receipt" r SET "paid_at" = m."occurred_at" FROM "cash_movement" m WHERE r."cash_movement_id" = m."movement_id"`,
    );

    await sql(
      `ALTER TABLE "maintenance_task" ADD CONSTRAINT "CHK_maintenance_task_pago" CHECK (num_nonnulls("cash_movement_id", "paid_at", "paid_amount") IN (0, 3) AND coalesce("paid_amount", 1) > 0 AND ("cash_movement_id" IS NULL OR "status" = 'done'))`,
    );
    await sql(
      `ALTER TABLE "tire" ADD CONSTRAINT "CHK_tire_pago" CHECK (("cash_movement_id" IS NULL) = ("paid_at" IS NULL))`,
    );
    await sql(
      `ALTER TABLE "vehicle_accident" ADD CONSTRAINT "CHK_vehicle_accident_pago" CHECK (num_nonnulls("payment_cash_movement_id", "payment_paid_at", "payment_amount") IN (0, 3) AND coalesce("payment_amount", 1) > 0)`,
    );
    await sql(
      `ALTER TABLE "vehicle_accident" ADD CONSTRAINT "CHK_vehicle_accident_reintegro" CHECK (num_nonnulls("reimbursement_cash_movement_id", "reimbursement_received_at", "reimbursement_amount") IN (0, 3) AND coalesce("reimbursement_amount", 1) > 0)`,
    );
    await sql(
      `ALTER TABLE "fuel_load" ADD CONSTRAINT "CHK_fuel_load_pago" CHECK (("cash_movement_id" IS NULL) = ("paid_at" IS NULL))`,
    );
    await sql(
      `ALTER TABLE "purchase_receipt" ADD CONSTRAINT "CHK_purchase_receipt_pago" CHECK (("paid_at" IS NULL OR "payment_status" = 'paid') AND ("cash_movement_id" IS NULL OR "paid_at" IS NOT NULL))`,
    );

    const fk = async (
      tabla: string,
      columna: string,
      nombre: string,
      nombreComp: string,
    ) => {
      await sql(
        `ALTER TABLE "${tabla}" ADD CONSTRAINT "${nombre}" FOREIGN KEY ("${columna}") REFERENCES "cash_movement"("movement_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
      );
      await sql(
        `ALTER TABLE "${tabla}" ADD CONSTRAINT "${nombreComp}" FOREIGN KEY ("${columna}", "distributor_id") REFERENCES "cash_movement"("movement_id","distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
      );
    };
    await fk(
      'maintenance_task',
      'cash_movement_id',
      'FK_maintenance_task_cash_movement',
      'FK_maintenance_task_cash_movement_distribuidora',
    );
    await fk(
      'tire',
      'cash_movement_id',
      'FK_tire_cash_movement',
      'FK_tire_cash_movement_distribuidora',
    );
    await fk(
      'vehicle_accident',
      'payment_cash_movement_id',
      'FK_vehicle_accident_payment_movement',
      'FK_vehicle_accident_payment_cash_movement_distribuidora',
    );
    await fk(
      'vehicle_accident',
      'reimbursement_cash_movement_id',
      'FK_vehicle_accident_reimbursement_movement',
      'FK_vehicle_accident_reimbursement_cash_movement_distribuidora',
    );

    await sql(`
      INSERT INTO "cash_category" ("distributor_id", "name", "direction", "system_code")
      SELECT d."distributor_id", c."name", c."direction"::"public"."cash_category_direction_enum", c."code"::"public"."cash_category_system_code_enum"
      FROM "distributor" d
      CROSS JOIN (VALUES
        ('Mantenimiento de flota', 'expense', 'fleet_maintenance'),
        ('Neumáticos', 'expense', 'tires'),
        ('Siniestros', 'expense', 'vehicle_accident'),
        ('Reintegros de seguros', 'income', 'insurance_reimbursement')
      ) AS c("name", "direction", "code")
      WHERE NOT EXISTS (
        SELECT 1 FROM "cash_category" x
        WHERE x."distributor_id" = d."distributor_id" AND x."system_code"::text = c."code"
      )
    `);
  }

  /** Aborta si hay pagos registrados: esa historia no se descarta sola. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const filas: unknown = await queryRunner.query(
      `SELECT
         (SELECT count(*) FROM "maintenance_task" WHERE "cash_movement_id" IS NOT NULL)
       + (SELECT count(*) FROM "tire" WHERE "cash_movement_id" IS NOT NULL)
       + (SELECT count(*) FROM "vehicle_accident" WHERE "payment_cash_movement_id" IS NOT NULL OR "reimbursement_cash_movement_id" IS NOT NULL) AS pagos`,
    );
    const { pagos } = (filas as Array<{ pagos: string }>)[0];
    if (Number(pagos) > 0) {
      throw new Error(
        `No se puede revertir: hay ${pagos} pagos de gastos de la flota registrados`,
      );
    }
    const sql = (texto: string) => queryRunner.query(texto);
    await sql(
      `ALTER TABLE "purchase_receipt" DROP CONSTRAINT "CHK_purchase_receipt_pago"`,
    );
    await sql(`ALTER TABLE "fuel_load" DROP CONSTRAINT "CHK_fuel_load_pago"`);
    await sql(`ALTER TABLE "purchase_receipt" DROP COLUMN "paid_at"`);
    await sql(`ALTER TABLE "fuel_load" DROP COLUMN "paid_at"`);
    await sql(
      `ALTER TABLE "vehicle_accident" DROP CONSTRAINT "FK_vehicle_accident_reimbursement_cash_movement_distribuidora", DROP CONSTRAINT "FK_vehicle_accident_reimbursement_movement", DROP CONSTRAINT "FK_vehicle_accident_payment_cash_movement_distribuidora", DROP CONSTRAINT "FK_vehicle_accident_payment_movement", DROP CONSTRAINT "CHK_vehicle_accident_reintegro", DROP CONSTRAINT "CHK_vehicle_accident_pago", DROP COLUMN "reimbursement_amount", DROP COLUMN "reimbursement_received_at", DROP COLUMN "reimbursement_cash_movement_id", DROP COLUMN "payment_amount", DROP COLUMN "payment_paid_at", DROP COLUMN "payment_cash_movement_id"`,
    );
    await sql(
      `ALTER TABLE "tire" DROP CONSTRAINT "FK_tire_cash_movement_distribuidora", DROP CONSTRAINT "FK_tire_cash_movement", DROP CONSTRAINT "CHK_tire_pago", DROP COLUMN "paid_at", DROP COLUMN "cash_movement_id"`,
    );
    await sql(
      `ALTER TABLE "maintenance_task" DROP CONSTRAINT "FK_maintenance_task_cash_movement_distribuidora", DROP CONSTRAINT "FK_maintenance_task_cash_movement", DROP CONSTRAINT "CHK_maintenance_task_pago", DROP COLUMN "paid_amount", DROP COLUMN "paid_at", DROP COLUMN "cash_movement_id"`,
    );
  }
}
