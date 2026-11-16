import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  sentenciasDeLaEncuesta,
  sentenciasParaQuitarLaEncuesta,
} from './sql/encuesta-del-chat';

/**
 * Encuesta de satisfacción al cerrar (4b) y botones de acción del cliente (4e):
 *
 * 1. `chat_company_settings`: `csat_enabled` (prendida), `csat_message` (con
 *    variables; nulo, el de omisión) y `customer_actions` (lista del catálogo;
 *    por omisión, todas).
 * 2. `conversation_rating`: una encuesta por cierre, de la misma empresa que
 *    la conversación y el mensaje que la pide (FK compuestas), con su cliente,
 *    quién atendió, puntaje 1–5, comentario, plazo (48 h) y respuesta única
 *    (`TRG_conversation_rating`, en `sql/encuesta-del-chat.ts`).
 */
export class EncuestaYAccionesDelChat1795000000125
  implements MigrationInterface
{
  name = 'EncuestaYAccionesDelChat1795000000125';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" ADD "csat_enabled" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" ADD "csat_message" character varying(500)`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" ADD "customer_actions" jsonb NOT NULL DEFAULT '["where_is_my_order", "repeat_last_order", "payment_methods", "talk_to_person"]'`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" ADD CONSTRAINT "CHK_chat_company_settings_encuesta" CHECK ("csat_message" IS NULL OR char_length(btrim("csat_message")) BETWEEN 1 AND 500)`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" ADD CONSTRAINT "CHK_chat_company_settings_acciones" CHECK (jsonb_typeof("customer_actions") = 'array' AND "customer_actions" <@ '["where_is_my_order", "repeat_last_order", "payment_methods", "talk_to_person"]'::jsonb)`,
    );
    await queryRunner.query(
      `CREATE TABLE "conversation_rating" (
        "rating_id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "distributor_id" uuid NOT NULL,
        "request_message_id" uuid NOT NULL,
        "customer_user_id" uuid NOT NULL,
        "served_by" character varying(10) NOT NULL,
        "score" smallint,
        "comment" character varying(280),
        "requested_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "answered_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "UQ_conversation_rating_pedido" UNIQUE ("request_message_id"),
        CONSTRAINT "CHK_conversation_rating_puntaje" CHECK ("score" IS NULL OR "score" BETWEEN 1 AND 5),
        CONSTRAINT "CHK_conversation_rating_respuesta" CHECK (("score" IS NULL) = ("answered_at" IS NULL) AND ("comment" IS NULL OR "score" IS NOT NULL)),
        CONSTRAINT "CHK_conversation_rating_comentario" CHECK ("comment" IS NULL OR char_length(btrim("comment")) BETWEEN 1 AND 280),
        CONSTRAINT "CHK_conversation_rating_plazo" CHECK ("expires_at" > "requested_at" AND ("answered_at" IS NULL OR "answered_at" <= "expires_at")),
        CONSTRAINT "CHK_conversation_rating_atendio" CHECK ("served_by" IN ('assistant', 'team', 'none')),
        CONSTRAINT "PK_conversation_rating" PRIMARY KEY ("rating_id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_rating_conversacion" ON "conversation_rating" ("conversation_id", "requested_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_rating_empresa" ON "conversation_rating" ("distributor_id", "requested_at")`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_rating" ADD CONSTRAINT "FK_conversation_rating_customer" FOREIGN KEY ("customer_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_rating" ADD CONSTRAINT "FK_conversation_rating_conversation_distribuidora" FOREIGN KEY ("conversation_id", "distributor_id") REFERENCES "conversation"("conversation_id", "distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_rating" ADD CONSTRAINT "FK_conversation_rating_request_message_distribuidora" FOREIGN KEY ("request_message_id", "distributor_id") REFERENCES "message"("message_id", "distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    for (const sentencia of sentenciasDeLaEncuesta()) {
      await queryRunner.query(sentencia);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const sentencia of sentenciasParaQuitarLaEncuesta()) {
      await queryRunner.query(sentencia);
    }
    await queryRunner.query(`DROP TABLE "conversation_rating"`);
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" DROP CONSTRAINT "CHK_chat_company_settings_acciones"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" DROP CONSTRAINT "CHK_chat_company_settings_encuesta"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" DROP COLUMN "customer_actions"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" DROP COLUMN "csat_message"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" DROP COLUMN "csat_enabled"`,
    );
  }
}
