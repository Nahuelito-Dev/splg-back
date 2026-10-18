import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * C-17: compra express y reintegros.
 * - `order`: recargo express cobrado (`express_surcharge_amount`) y cuándo el pedido
 *   pasó al reparto común (`express_degraded_at`).
 * - `payment_refund`: una solicitud de devolución a la pasarela por pago y tipo.
 */
export class ExpressYReintegros1792244000000 implements MigrationInterface {
  name = 'ExpressYReintegros1792244000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."payment_refund_kind_enum" AS ENUM('full', 'express_surcharge')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."payment_refund_status_enum" AS ENUM('pending', 'succeeded', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "payment_refund" ("refund_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "payment_id" uuid NOT NULL, "order_id" uuid NOT NULL, "distributor_id" uuid, "kind" "public"."payment_refund_kind_enum" NOT NULL, "amount" numeric(10,2) NOT NULL, "status" "public"."payment_refund_status_enum" NOT NULL DEFAULT 'pending', "gateway_refund_id" character varying(100), "error_message" text, "attempts" integer NOT NULL DEFAULT '0', "refunded_at" TIMESTAMP WITH TIME ZONE, "requested_by_user_id" uuid, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_payment_refund_payment_kind" UNIQUE ("payment_id", "kind"), CONSTRAINT "PK_b2ceff76c7c89bdd2259d27a8a7" PRIMARY KEY ("refund_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_9b1ba9fb797de22fc87b598f50" ON "payment_refund" ("payment_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ddf9b0a3d9abeee97fa77f0f20" ON "payment_refund" ("order_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_9649d0833082fad8f431ff1381" ON "payment_refund" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_a2ae8bef86602c9f97be8e0b41" ON "payment_refund" ("status") `,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD "express_surcharge_amount" numeric(10,2) NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD "express_degraded_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_refund" ADD CONSTRAINT "FK_9b1ba9fb797de22fc87b598f509" FOREIGN KEY ("payment_id") REFERENCES "payment"("payment_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_refund" ADD CONSTRAINT "FK_ddf9b0a3d9abeee97fa77f0f204" FOREIGN KEY ("order_id") REFERENCES "order"("order_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_refund" ADD CONSTRAINT "FK_9649d0833082fad8f431ff1381f" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payment_refund" DROP CONSTRAINT "FK_9649d0833082fad8f431ff1381f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_refund" DROP CONSTRAINT "FK_ddf9b0a3d9abeee97fa77f0f204"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_refund" DROP CONSTRAINT "FK_9b1ba9fb797de22fc87b598f509"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" DROP COLUMN "express_degraded_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" DROP COLUMN "express_surcharge_amount"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_a2ae8bef86602c9f97be8e0b41"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_9649d0833082fad8f431ff1381"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_ddf9b0a3d9abeee97fa77f0f20"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_9b1ba9fb797de22fc87b598f50"`,
    );
    await queryRunner.query(`DROP TABLE "payment_refund"`);
    await queryRunner.query(`DROP TYPE "public"."payment_refund_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."payment_refund_kind_enum"`);
  }
}
