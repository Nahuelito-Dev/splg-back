import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Recupero de envases según el riesgo del cliente y retiro aprovechando la hoja (M5):
 *  - enum `recovery_risk_band_enum` y tabla `customer_recovery_score`: por cliente y
 *    distribuidora, casos demorados ÷ pedidos entregados, suavizado, y su banda;
 *  - `cylinder_recovery_notice.route_batch_id`: la hoja de ruta de la que se aprovechó
 *    el viaje (sólo en la oferta de retiro) y su CHECK;
 *  - los parámetros nuevos de `cylinder_recovery` (porcentajes de tolerancia y de
 *    escalón por banda, radio del retiro) en el CHECK de `module_config`.
 *    No hay valor que migrar: sin la clave rige el valor por omisión.
 */
/** Rangos de los parámetros del recupero antes de esta migración (copia congelada). */
const RANGOS_ANTERIORES: ReadonlyArray<[string, number, number]> = [
  ['toleranceDays', 1, 365],
  ['escalationStepDays', 1, 90],
  ['escalationAmountThreshold', 0, 100_000_000],
  ['pickupOfferTtlHours', 1, 720],
  ['pickupWindowDays', 1, 60],
  ['runHour', 0, 23],
  ['enabled', 0, 1],
];
const RANGOS_NUEVOS: ReadonlyArray<[string, number, number]> = [
  ['toleranceDays', 1, 365],
  ['escalationStepDays', 1, 90],
  ['escalationAmountThreshold', 0, 100_000_000],
  ['pickupOfferTtlHours', 1, 720],
  ['pickupWindowDays', 1, 60],
  ['toleranceLowRiskPercent', 10, 300],
  ['toleranceMediumRiskPercent', 10, 300],
  ['toleranceHighRiskPercent', 10, 300],
  ['stepLowRiskPercent', 10, 300],
  ['stepMediumRiskPercent', 10, 300],
  ['stepHighRiskPercent', 10, 300],
  ['opportunisticPickupRadiusMeters', 50, 2000],
  ['runHour', 0, 23],
  ['enabled', 0, 1],
];

const checkDelRecupero = (rangos: ReadonlyArray<[string, number, number]>) =>
  `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_recuperacion" CHECK ("module"::text <> 'cylinder_recovery' OR (${rangos
    .map(
      ([k, min, max]) =>
        `("params" -> '${k}' IS NULL OR (jsonb_typeof("params" -> '${k}') = 'number' AND ("params" ->> '${k}')::numeric BETWEEN ${min} AND ${max}${k === 'escalationAmountThreshold' ? '' : ` AND ("params" ->> '${k}')::numeric = trunc(("params" ->> '${k}')::numeric)`}))`,
    )
    .join(' AND ')}))`;

export class PuntajeDeRecuperoYRetiroOportunista1795000000250
  implements MigrationInterface
{
  name = 'PuntajeDeRecuperoYRetiroOportunista1795000000250';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."recovery_risk_band_enum" AS ENUM('low', 'medium', 'high')`,
    );
    await queryRunner.query(
      `CREATE TABLE "customer_recovery_score" ("score_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "customer_user_id" uuid NOT NULL, "delayed_cases" integer NOT NULL, "orders_total" integer NOT NULL, "score" numeric(5,4) NOT NULL, "band" "public"."recovery_risk_band_enum" NOT NULL, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "CHK_customer_recovery_score_puntaje" CHECK ("score" BETWEEN 0 AND 1), CONSTRAINT "CHK_customer_recovery_score_cantidades" CHECK ("delayed_cases" >= 0 AND "orders_total" >= 0), CONSTRAINT "PK_customer_recovery_score" PRIMARY KEY ("score_id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_customer_recovery_score_cliente" ON "customer_recovery_score" ("distributor_id", "customer_user_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_recovery_score" ADD CONSTRAINT "FK_75d20b091f965bc0e841b27160e" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_recovery_score" ADD CONSTRAINT "FK_eb9f2ab5eb3ae04c35ac34c0614" FOREIGN KEY ("customer_user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_notice" ADD "route_batch_id" uuid`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_recovery_notice_hoja" ON "cylinder_recovery_notice" ("route_batch_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_notice" ADD CONSTRAINT "FK_fc99a8eeef8d0f5c326d98343c0" FOREIGN KEY ("route_batch_id") REFERENCES "route_batch"("batch_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_notice" DROP CONSTRAINT "CHK_recovery_notice_oferta"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_notice" ADD CONSTRAINT "CHK_recovery_notice_oferta" CHECK ((("kind" = 'pickup_offer') = ("order_id" IS NOT NULL)) AND (("kind" = 'pickup_offer') = ("status" IS NOT NULL)) AND ("status" NOT IN ('accepted', 'rejected') OR "responded_at" IS NOT NULL) AND ("status" <> 'pending' OR "responded_at" IS NULL) AND ("expires_at" >= "sent_at") AND ("step" BETWEEN 1 AND 3) AND ("route_batch_id" IS NULL OR "kind" = 'pickup_offer'))`,
    );

    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_recuperacion"`,
    );
    await queryRunner.query(checkDelRecupero(RANGOS_NUEVOS));
  }

  /**
   * Repone el CHECK anterior (los parámetros nuevos ya guardados no lo violan: sólo
   * restringe las claves que lista) y quita lo agregado. Las ofertas aprovechando una
   * hoja se pierden con su columna; el enum de la banda se borra con la tabla.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_recuperacion"`,
    );
    await queryRunner.query(checkDelRecupero(RANGOS_ANTERIORES));
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_notice" DROP CONSTRAINT "CHK_recovery_notice_oferta"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_notice" ADD CONSTRAINT "CHK_recovery_notice_oferta" CHECK ((("kind" = 'pickup_offer') = ("order_id" IS NOT NULL)) AND (("kind" = 'pickup_offer') = ("status" IS NOT NULL)) AND ("status" NOT IN ('accepted', 'rejected') OR "responded_at" IS NOT NULL) AND ("status" <> 'pending' OR "responded_at" IS NULL) AND ("expires_at" >= "sent_at") AND ("step" BETWEEN 1 AND 3))`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_notice" DROP CONSTRAINT "FK_fc99a8eeef8d0f5c326d98343c0"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_recovery_notice_hoja"`);
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_notice" DROP COLUMN "route_batch_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_recovery_score" DROP CONSTRAINT "FK_eb9f2ab5eb3ae04c35ac34c0614"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_recovery_score" DROP CONSTRAINT "FK_75d20b091f965bc0e841b27160e"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_customer_recovery_score_cliente"`,
    );
    await queryRunner.query(`DROP TABLE "customer_recovery_score"`);
    await queryRunner.query(`DROP TYPE "public"."recovery_risk_band_enum"`);
  }
}
