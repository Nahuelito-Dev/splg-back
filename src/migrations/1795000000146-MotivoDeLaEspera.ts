import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tanda 8b, decisión de nahue (17/11): al apagar la asignación automática se
 * limpian las esperas que puso ella; las que puso el asistente al derivar (o
 * el cliente con «hablar con una persona») quedan. Para distinguirlas:
 *
 * 1. `conversation.awaiting_human_reason` (`handoff` | `auto_assign`), nula
 *    si no espera, con su CHECK. Las que ya esperaban quedan `handoff`.
 * 2. `TRG_conversation_motivo_de_espera`: si se marca la espera sin motivo
 *    (la derivación del asistente, los caminos de siempre) pone `handoff`; si
 *    se limpia la espera, limpia el motivo. Así ningún camino que ya existía
 *    tiene que conocer la columna.
 *
 * La auditoría de la columna la instala la siguiente
 * (`AuditoriaDelMotivoDeLaEspera`).
 */
export class MotivoDeLaEspera1795000000146 implements MigrationInterface {
  name = 'MotivoDeLaEspera1795000000146';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversation" ADD "awaiting_human_reason" character varying(15)`,
    );
    await queryRunner.query(
      `UPDATE "conversation" SET "awaiting_human_reason" = 'handoff' WHERE "awaiting_human_since" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" ADD CONSTRAINT "CHK_conversation_motivo_de_espera" CHECK (("awaiting_human_since" IS NULL) = ("awaiting_human_reason" IS NULL) AND ("awaiting_human_reason" IS NULL OR "awaiting_human_reason" IN ('handoff', 'auto_assign')))`,
    );
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION conversation_motivo_de_espera() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW."awaiting_human_since" IS NULL THEN
           NEW."awaiting_human_reason" := NULL;
         ELSIF NEW."awaiting_human_reason" IS NULL THEN
           NEW."awaiting_human_reason" := 'handoff';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "TRG_conversation_motivo_de_espera" BEFORE INSERT OR UPDATE OF "awaiting_human_since", "awaiting_human_reason" ON "conversation" FOR EACH ROW EXECUTE FUNCTION conversation_motivo_de_espera()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "TRG_conversation_motivo_de_espera" ON "conversation"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS conversation_motivo_de_espera()`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP CONSTRAINT "CHK_conversation_motivo_de_espera"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP COLUMN "awaiting_human_reason"`,
    );
  }
}
