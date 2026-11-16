import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Alerta de fraude de Mercado Pago (`stop_delivery_op_wh`):
 *  - `order.payment_fraud_hold`: el pedido retenido (también una reserva con seña paga)
 *    no se ofrece, no se acepta, no se asigna y no se activa;
 *  - `payment_notification_inbox`: bandeja de entrada de los avisos que Mercado Pago no
 *    reintenta; se guarda el aviso crudo, se contesta 200 y se procesa después.
 */
export class RetencionPorFraudeYBandejaDeAvisos1794700000012
  implements MigrationInterface
{
  name = 'RetencionPorFraudeYBandejaDeAvisos1794700000012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order" ADD "payment_fraud_hold" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD "payment_fraud_released_at" TIMESTAMP WITH TIME ZONE, ADD "payment_fraud_released_by" uuid, ADD "payment_fraud_released_reason" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD CONSTRAINT "CHK_order_liberacion_por_fraude" CHECK ("payment_fraud_released_at" IS NULL OR ("payment_fraud_released_by" IS NOT NULL AND char_length(btrim("payment_fraud_released_reason")) >= 10))`,
    );
    await queryRunner.query(
      `CREATE TABLE "payment_notification_inbox" (
         "notification_id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "type" character varying(60) NOT NULL,
         "data_id" character varying(100) NOT NULL,
         "credential_id" uuid,
         "raw_body" jsonb,
         "status" character varying(20) NOT NULL DEFAULT 'pending',
         "attempts" integer NOT NULL DEFAULT 0,
         "last_error" text,
         "next_attempt_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         "processed_at" TIMESTAMP WITH TIME ZONE,
         "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "CHK_payment_notification_inbox_estado" CHECK ("status" IN ('pending', 'processed', 'failed')),
         CONSTRAINT "CHK_payment_notification_inbox_intentos" CHECK ("attempts" >= 0),
         CONSTRAINT "PK_payment_notification_inbox" PRIMARY KEY ("notification_id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_payment_notification_inbox_aviso" ON "payment_notification_inbox" ("type", "data_id", "credential_id") WHERE "credential_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_payment_notification_inbox_aviso_sistema" ON "payment_notification_inbox" ("type", "data_id") WHERE "credential_id" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_payment_notification_inbox_pendientes" ON "payment_notification_inbox" ("status", "next_attempt_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "payment_notification_inbox"`);
    await queryRunner.query(
      `ALTER TABLE "order" DROP CONSTRAINT "CHK_order_liberacion_por_fraude"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" DROP COLUMN "payment_fraud_released_reason", DROP COLUMN "payment_fraud_released_by", DROP COLUMN "payment_fraud_released_at", DROP COLUMN "payment_fraud_hold"`,
    );
  }
}
