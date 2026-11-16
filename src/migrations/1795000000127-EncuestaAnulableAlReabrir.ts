import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  CREAR_ENCUESTA_DEL_CHAT,
  sentenciasDeLaEncuestaAnulable,
} from './sql/encuesta-del-chat';

/**
 * La encuesta de un cierre se anula si la conversación se reabre antes de que
 * la respondan (4b): `conversation_rating.cancelled_at`, con su CHECK (no
 * respondida y no antes de pedida) y el trigger que deja responder o anular
 * una sola vez.
 */
export class EncuestaAnulableAlReabrir1795000000127
  implements MigrationInterface
{
  name = 'EncuestaAnulableAlReabrir1795000000127';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversation_rating" ADD "cancelled_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_rating" ADD CONSTRAINT "CHK_conversation_rating_anulada" CHECK ("cancelled_at" IS NULL OR ("answered_at" IS NULL AND "cancelled_at" >= "requested_at"))`,
    );
    for (const sentencia of sentenciasDeLaEncuestaAnulable()) {
      await queryRunner.query(sentencia);
    }
  }

  /**
   * Vuelve a la función de la 125. Una anulada quedaría como pendiente: si hay
   * alguna, frena (no se reabre una encuesta de un cierre ya reabierto).
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "conversation_rating" WHERE "cancelled_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'No se puede deshacer EncuestaAnulableAlReabrir: hay encuestas anuladas que volverían a quedar pendientes; corregí hacia adelante con una migración nueva.'
      USING ERRCODE = '55000';
  END IF;
END $$`);
    const funcion = CREAR_ENCUESTA_DEL_CHAT[0].replace(
      'CREATE FUNCTION',
      'CREATE OR REPLACE FUNCTION',
    );
    await queryRunner.query(funcion);
    await queryRunner.query(
      `ALTER TABLE "conversation_rating" DROP CONSTRAINT "CHK_conversation_rating_anulada"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_rating" DROP COLUMN "cancelled_at"`,
    );
  }
}
