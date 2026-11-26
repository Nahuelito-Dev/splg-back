import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Registro de avisos enviados (`notification_log`): una fila por cada push o
 * correo que sale del sistema, con el destino enmascarado, el estado y el
 * pedido al que se refiere. Sólo se agrega; no se purga.
 */
export class RegistroDeAvisosEnviados1795000000210
  implements MigrationInterface
{
  name = 'RegistroDeAvisosEnviados1795000000210';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "notification_log" (
        "notification_log_id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "distributor_id" uuid,
        "channel" character varying(10) NOT NULL,
        "type" character varying(60) NOT NULL,
        "recipient_user_id" uuid,
        "recipient_masked" character varying(120) NOT NULL,
        "subject" character varying(200),
        "status" character varying(10) NOT NULL,
        "error" character varying(300),
        "related_order_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notification_log" PRIMARY KEY ("notification_log_id"),
        CONSTRAINT "CHK_notification_log_canal" CHECK ("channel" IN ('push', 'email')),
        CONSTRAINT "CHK_notification_log_estado" CHECK ("status" IN ('sent', 'failed', 'skipped')),
        CONSTRAINT "CHK_notification_log_error" CHECK ("status" <> 'sent' OR "error" IS NULL)
      )`,
    );
    await q.query(
      `ALTER TABLE "notification_log" ADD CONSTRAINT "FK_notification_log_distribuidora" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "notification_log" ADD CONSTRAINT "FK_notification_log_destinatario" FOREIGN KEY ("recipient_user_id") REFERENCES "user"("user_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "notification_log" ADD CONSTRAINT "FK_notification_log_pedido" FOREIGN KEY ("related_order_id") REFERENCES "order"("order_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await q.query(
      `CREATE INDEX "IDX_notification_log_distribuidora_fecha" ON "notification_log" ("distributor_id", "created_at" DESC)`,
    );
    // El filtro frecuente del panel: los avisos fallidos o salteados de la empresa.
    await q.query(
      `CREATE INDEX "IDX_notification_log_distribuidora_estado_fecha" ON "notification_log" ("distributor_id", "status", "created_at" DESC)`,
    );
    await q.query(
      `CREATE INDEX "IDX_notification_log_pedido" ON "notification_log" ("related_order_id")`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "notification_log"`);
  }
}
