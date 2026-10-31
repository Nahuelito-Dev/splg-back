import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M4, agrupación por recorrido (CU-107): lo que le falta al modelo de lotes
 * para operar. El cierre del lote (cuándo y por qué), la parada viva con su
 * llegada estimada y el tramo, y las reglas en la base: un pedido en un solo
 * lote vivo, una sola oferta viva por lote, un chofer una sola vez por lote y
 * los rangos de los parámetros de la agrupación.
 */
export class BatchesDeRecorrido1794700000000 implements MigrationInterface {
  name = 'BatchesDeRecorrido1794700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD "closed_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."route_batch_close_reason_enum" AS ENUM('exhausted', 'orders_unavailable', 'admin')`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD "close_reason" "public"."route_batch_close_reason_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD "active" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD "eta_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD "leg_distance_km" numeric(8,2) NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_route_batch_stop_pedido_activo" ON "route_batch_stop" ("order_id") WHERE "active"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_route_batch_offer_viva" ON "route_batch_offer" ("batch_id") WHERE "status" = 'pending'`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "CHK_route_batch_motivo" CHECK (("status" = 'dissolved') = ("close_reason" IS NOT NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "CHK_route_batch_cierre" CHECK (("status" IN ('dissolved', 'completed')) = ("closed_at" IS NOT NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "CHK_route_batch_chofer" CHECK ("status" NOT IN ('assigned', 'completed') OR "delivery_id" IS NOT NULL)`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "CHK_route_batch_peso" CHECK ("total_weight_kg" >= 0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD CONSTRAINT "CHK_route_batch_stop_tramo" CHECK ("leg_distance_km" >= 0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_offer" ADD CONSTRAINT "CHK_route_batch_offer_respuesta" CHECK (("status" = 'pending') = ("responded_at" IS NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "CHK_module_config_agrupacion" CHECK ("module" <> 'route_batching' OR (("params" -> 'maxBatchSize' IS NULL OR (jsonb_typeof("params" -> 'maxBatchSize') = 'number' AND ("params" ->> 'maxBatchSize')::numeric BETWEEN 2 AND 20 AND ("params" ->> 'maxBatchSize')::numeric = trunc(("params" ->> 'maxBatchSize')::numeric))) AND ("params" -> 'groupingRadiusKm' IS NULL OR (jsonb_typeof("params" -> 'groupingRadiusKm') = 'number' AND ("params" ->> 'groupingRadiusKm')::numeric BETWEEN 0.5 AND 50)) AND ("params" -> 'slotToleranceMinutes' IS NULL OR (jsonb_typeof("params" -> 'slotToleranceMinutes') = 'number' AND ("params" ->> 'slotToleranceMinutes')::numeric BETWEEN 0 AND 480 AND ("params" ->> 'slotToleranceMinutes')::numeric = trunc(("params" ->> 'slotToleranceMinutes')::numeric))) AND ("params" -> 'offerTtlSeconds' IS NULL OR (jsonb_typeof("params" -> 'offerTtlSeconds') = 'number' AND ("params" ->> 'offerTtlSeconds')::numeric BETWEEN 10 AND 600 AND ("params" ->> 'offerTtlSeconds')::numeric = trunc(("params" ->> 'offerTtlSeconds')::numeric))) AND ("params" -> 'evaluationFrequencyMinutes' IS NULL OR (jsonb_typeof("params" -> 'evaluationFrequencyMinutes') = 'number' AND ("params" ->> 'evaluationFrequencyMinutes')::numeric BETWEEN 1 AND 1440 AND ("params" ->> 'evaluationFrequencyMinutes')::numeric = trunc(("params" ->> 'evaluationFrequencyMinutes')::numeric)))))`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_offer" ADD CONSTRAINT "UQ_route_batch_offer_batch_delivery" UNIQUE ("batch_id", "delivery_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "route_batch_offer" DROP CONSTRAINT "UQ_route_batch_offer_batch_delivery"`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "CHK_module_config_agrupacion"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_offer" DROP CONSTRAINT "CHK_route_batch_offer_respuesta"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" DROP CONSTRAINT "CHK_route_batch_stop_tramo"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "CHK_route_batch_peso"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "CHK_route_batch_chofer"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "CHK_route_batch_cierre"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "CHK_route_batch_motivo"`,
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_route_batch_offer_viva"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_route_batch_stop_pedido_activo"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" DROP COLUMN "leg_distance_km"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" DROP COLUMN "eta_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" DROP COLUMN "active"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP COLUMN "close_reason"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."route_batch_close_reason_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP COLUMN "closed_at"`,
    );
  }
}
