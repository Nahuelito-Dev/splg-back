import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  FRENAR_SI_HAY_NOTAS,
  sentenciasDeNotasInternas,
  sentenciasParaQuitarNotasInternas,
} from './sql/notas-internas-de-la-bandeja';

/**
 * Notas internas de la bandeja con @menciones (4a) y la nota de derivación
 * del asistente con IA (4c):
 *
 * 1. `CHK_message_visibilidad`: una nota interna es un texto de la plataforma
 *    o del personal, o el mensaje de sistema `handoff_note` del asistente. El
 *    canal lo controla `TRG_message_canal` (`sql/notas-internas-de-la-bandeja.ts`).
 * 2. `message_mention`: a quién menciona cada nota, con su marca de leído; de
 *    la misma empresa que la nota y la conversación (FK compuestas) y del
 *    personal de esa empresa (`TRG_message_mention`).
 * 3. `admin_notification.recipient_user_id`: el aviso de una mención es sólo
 *    para la persona mencionada.
 */
export class NotasInternasDeLaBandeja1795000000123
  implements MigrationInterface
{
  name = 'NotasInternasDeLaBandeja1795000000123';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "message" DROP CONSTRAINT "CHK_message_visibilidad"`,
    );
    await queryRunner.query(
      `ALTER TABLE "message" ADD CONSTRAINT "CHK_message_visibilidad" CHECK ("visibility" IN ('all', 'internal') AND ("visibility" = 'all' OR ("kind" = 'text' AND "sender_party" IN ('platform', 'company')) OR ("kind" = 'system' AND "sender_party" = 'system' AND "system_code" = 'handoff_note')))`,
    );
    await queryRunner.query(
      `CREATE TABLE "message_mention" (
        "mention_id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "message_id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "distributor_id" uuid NOT NULL,
        "mentioned_user_id" uuid NOT NULL,
        "read_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_message_mention_persona" UNIQUE ("message_id", "mentioned_user_id"),
        CONSTRAINT "CHK_message_mention_lectura" CHECK ("read_at" IS NULL OR "read_at" >= "created_at"),
        CONSTRAINT "PK_message_mention" PRIMARY KEY ("mention_id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_message_mention_de_la_persona" ON "message_mention" ("mentioned_user_id", "distributor_id", "read_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_message_mention_conversacion" ON "message_mention" ("conversation_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "message_mention" ADD CONSTRAINT "FK_message_mention_mentioned" FOREIGN KEY ("mentioned_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "message_mention" ADD CONSTRAINT "FK_message_mention_message_distribuidora" FOREIGN KEY ("message_id", "distributor_id") REFERENCES "message"("message_id", "distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "message_mention" ADD CONSTRAINT "FK_message_mention_conversation_distribuidora" FOREIGN KEY ("conversation_id", "distributor_id") REFERENCES "conversation"("conversation_id", "distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin_notification" ADD "recipient_user_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin_notification" ADD CONSTRAINT "CHK_admin_notification_destinatario" CHECK ("recipient_user_id" IS NULL OR "distributor_id" IS NOT NULL)`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin_notification" ADD CONSTRAINT "FK_admin_notification_recipient" FOREIGN KEY ("recipient_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    for (const sentencia of sentenciasDeNotasInternas()) {
      await queryRunner.query(sentencia);
    }
  }

  /**
   * Sólo en una base sin notas, menciones ni avisos para una persona: si los
   * hay, frena con un mensaje claro (por qué, en `FRENAR_SI_HAY_NOTAS`).
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(FRENAR_SI_HAY_NOTAS);
    for (const sentencia of sentenciasParaQuitarNotasInternas()) {
      await queryRunner.query(sentencia);
    }
    await queryRunner.query(
      `ALTER TABLE "admin_notification" DROP CONSTRAINT "FK_admin_notification_recipient"`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin_notification" DROP CONSTRAINT "CHK_admin_notification_destinatario"`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin_notification" DROP COLUMN "recipient_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "message_mention"`);
    await queryRunner.query(
      `ALTER TABLE "message" DROP CONSTRAINT "CHK_message_visibilidad"`,
    );
    await queryRunner.query(
      `ALTER TABLE "message" ADD CONSTRAINT "CHK_message_visibilidad" CHECK ("visibility" IN ('all', 'internal') AND ("visibility" = 'all' OR ("sender_party" = 'platform' AND "kind" = 'text')))`,
    );
  }
}
