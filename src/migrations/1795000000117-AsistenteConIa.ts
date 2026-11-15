import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Asistente del chat con IA, etapa B3 (DISENO-CH-BOT §4, §5 y §6):
 *
 * 1. `chat_company_settings.assistant_ai_enabled`: el interruptor de cada
 *    empresa para que el asistente conteste a sus clientes (C3). Apagado.
 * 2. `platform_support_settings`: el interruptor del soporte de la plataforma
 *    (C1) y los topes (§6): respuestas por conversación (1–50, 10) y tokens
 *    por mes (10.000–1.000.000.000, 2.000.000).
 * 3. `conversation.awaiting_human_since`: el asistente la pasó a una persona;
 *    sólo en C3 y C1.
 * 4. `assistant_trace`: una fila por mensaje que atendió el asistente
 *    (respondió o derivó, motivo, modelo, tokens, latencia; nunca el texto),
 *    con las claves cruzadas de la empresa a la conversación y a los mensajes.
 */
export class AsistenteConIa1795000000117 implements MigrationInterface {
  name = 'AsistenteConIa1795000000117';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" ADD "assistant_ai_enabled" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_support_settings" ADD "assistant_ai_enabled" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_support_settings" ADD "assistant_replies_per_conversation" smallint NOT NULL DEFAULT '10'`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_support_settings" ADD "assistant_monthly_token_limit" integer NOT NULL DEFAULT '2000000'`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_support_settings" ADD CONSTRAINT "CHK_platform_support_settings_asistente" CHECK ("assistant_replies_per_conversation" BETWEEN 1 AND 50 AND "assistant_monthly_token_limit" BETWEEN 10000 AND 1000000000)`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" ADD "awaiting_human_since" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" ADD CONSTRAINT "CHK_conversation_esperando_persona" CHECK ("awaiting_human_since" IS NULL OR "channel" IN ('platform_chat', 'staff_customer'))`,
    );
    await queryRunner.query(
      `CREATE TABLE "assistant_trace" (
        "trace_id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "distributor_id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "channel" character varying(20) NOT NULL,
        "trigger_message_id" uuid NOT NULL,
        "reply_message_id" uuid,
        "outcome" character varying(12) NOT NULL,
        "reason" character varying(20),
        "model" character varying(60),
        "input_tokens" integer NOT NULL DEFAULT '0',
        "output_tokens" integer NOT NULL DEFAULT '0',
        "cache_read_tokens" integer NOT NULL DEFAULT '0',
        "cache_creation_tokens" integer NOT NULL DEFAULT '0',
        "tools_used" jsonb NOT NULL DEFAULT '[]',
        "latency_ms" integer NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_assistant_trace_disparador" UNIQUE ("trigger_message_id"),
        CONSTRAINT "CHK_assistant_trace_canal" CHECK ("channel" IN ('platform_chat', 'staff_customer')),
        CONSTRAINT "CHK_assistant_trace_resultado" CHECK ("outcome" IN ('answered', 'handed_off') AND ("outcome" = 'handed_off') = ("reason" IS NOT NULL)),
        CONSTRAINT "CHK_assistant_trace_motivo" CHECK ("reason" IS NULL OR "reason" IN ('requested', 'refusal', 'max_tokens', 'no_text', 'invalid_text', 'tool_rounds', 'timeout', 'rate_limited', 'api_error', 'unavailable', 'reply_limit', 'monthly_limit')),
        CONSTRAINT "CHK_assistant_trace_tokens" CHECK ("input_tokens" >= 0 AND "output_tokens" >= 0 AND "cache_read_tokens" >= 0 AND "cache_creation_tokens" >= 0 AND "latency_ms" >= 0),
        CONSTRAINT "CHK_assistant_trace_herramientas" CHECK (jsonb_typeof("tools_used") = 'array'),
        CONSTRAINT "PK_assistant_trace" PRIMARY KEY ("trace_id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_assistant_trace_mes" ON "assistant_trace" ("channel", "distributor_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_assistant_trace_conversacion" ON "assistant_trace" ("conversation_id", "outcome")`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_trace" ADD CONSTRAINT "FK_assistant_trace_distributor" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_trace" ADD CONSTRAINT "FK_assistant_trace_conversation_distribuidora" FOREIGN KEY ("conversation_id", "distributor_id") REFERENCES "conversation"("conversation_id", "distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_trace" ADD CONSTRAINT "FK_assistant_trace_trigger_message_distribuidora" FOREIGN KEY ("trigger_message_id", "distributor_id") REFERENCES "message"("message_id", "distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_trace" ADD CONSTRAINT "FK_assistant_trace_reply_message_distribuidora" FOREIGN KEY ("reply_message_id", "distributor_id") REFERENCES "message"("message_id", "distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "assistant_trace"`);
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP CONSTRAINT "CHK_conversation_esperando_persona"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP COLUMN "awaiting_human_since"`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_support_settings" DROP CONSTRAINT "CHK_platform_support_settings_asistente"`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_support_settings" DROP COLUMN "assistant_monthly_token_limit"`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_support_settings" DROP COLUMN "assistant_replies_per_conversation"`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_support_settings" DROP COLUMN "assistant_ai_enabled"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" DROP COLUMN "assistant_ai_enabled"`,
    );
  }
}
