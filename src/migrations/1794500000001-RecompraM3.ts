import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Recompra anticipada (M3, CU-106, CU-145 y CU-146).
 *
 * - `customer`: el aviso se puede desactivar (`repurchase_notice_enabled`) y los
 *   días de anticipación son una elección del cliente: sin elegir (`NULL`) rige
 *   el valor de la distribuidora. Los 3 días que la columna traía por omisión no
 *   eran una elección, así que vuelven a `NULL`.
 * - `repurchase_invitation`: franja y medio de pago habituales, de dónde salió la
 *   estimación y las reglas del ciclo (una sola abierta por cliente y
 *   distribuidora, respuesta y pedido coherentes con el estado).
 * - `module_config`: rango de los parámetros del proceso `repurchase`.
 */
const RANGOS: ReadonlyArray<[string, number, number]> = [
  ['minOrders', 2, 50],
  ['anticipationDays', 1, 30],
  ['invitationTtlHours', 1, 168],
  ['minIntervalDays', 1, 90],
  ['runHour', 0, 23],
  ['recentOrderDays', 1, 30],
  ['staleDays', 7, 365],
];

const rango = (k: string, min: number, max: number) =>
  `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN ${min} AND ${max} AND ("params" ->> '${k}')::numeric = trunc(("params" ->> '${k}')::numeric)))`;

const CHECK_RECOMPRA = RANGOS.map(([k, min, max]) => rango(k, min, max)).join(
  ' AND ',
);

export class RecompraM31794500000001 implements MigrationInterface {
  name = 'RecompraM31794500000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "customer" ADD "repurchase_notice_enabled" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer" ALTER COLUMN "repurchase_notice_days" DROP DEFAULT`,
    );
    await queryRunner.query(
      `UPDATE "customer" SET "repurchase_notice_days" = NULL WHERE "repurchase_notice_days" = 3`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer" ADD CONSTRAINT "CHK_customer_aviso_recompra" CHECK ("repurchase_notice_days" IS NULL OR "repurchase_notice_days" BETWEEN 1 AND 30)`,
    );

    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" ADD "time_slot_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" ADD "payment_method" character varying(20) NOT NULL DEFAULT 'cash'`,
    );
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" ADD "estimate_source" character varying(10) NOT NULL DEFAULT 'history'`,
    );
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" ADD CONSTRAINT "FK_repurchase_invitation_time_slot" FOREIGN KEY ("time_slot_id") REFERENCES "time_slot"("time_slot_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" ADD CONSTRAINT "CHK_repurchase_invitation_vigencia" CHECK ("expires_at" > "created_at")`,
    );
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" ADD CONSTRAINT "CHK_repurchase_invitation_respuesta" CHECK (("status" = 'pending') = ("responded_at" IS NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" ADD CONSTRAINT "CHK_repurchase_invitation_pedido" CHECK (("status" = 'accepted') = ("order_id" IS NOT NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" ADD CONSTRAINT "CHK_repurchase_invitation_renglones" CHECK (jsonb_typeof("suggested_items") = 'array' AND jsonb_array_length("suggested_items") > 0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" ADD CONSTRAINT "CHK_repurchase_invitation_pago" CHECK ("payment_method" IN ('cash', 'transfer', 'mercadopago'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" ADD CONSTRAINT "CHK_repurchase_invitation_fuente" CHECK ("estimate_source" IN ('history', 'declared'))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_repurchase_invitation_abierta" ON "repurchase_invitation" ("distributor_id", "user_id") WHERE "status" = 'pending'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_repurchase_invitation_estado" ON "repurchase_invitation" ("distributor_id", "status", "created_at")`,
    );

    await queryRunner.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_recompra" CHECK ("module" <> 'repurchase' OR (${CHECK_RECOMPRA}))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_recompra"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_repurchase_invitation_estado"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_repurchase_invitation_abierta"`,
    );
    for (const c of [
      'CHK_repurchase_invitation_fuente',
      'CHK_repurchase_invitation_pago',
      'CHK_repurchase_invitation_renglones',
      'CHK_repurchase_invitation_pedido',
      'CHK_repurchase_invitation_respuesta',
      'CHK_repurchase_invitation_vigencia',
      'FK_repurchase_invitation_time_slot',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "repurchase_invitation" DROP CONSTRAINT "${c}"`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" DROP COLUMN "estimate_source"`,
    );
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" DROP COLUMN "payment_method"`,
    );
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" DROP COLUMN "time_slot_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer" DROP CONSTRAINT "CHK_customer_aviso_recompra"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer" ALTER COLUMN "repurchase_notice_days" SET DEFAULT 3`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer" DROP COLUMN "repurchase_notice_enabled"`,
    );
  }
}
