import { MigrationInterface, QueryRunner } from 'typeorm';

/** Limita el comentario de una decisión, también para escrituras fuera de la API. */
export class LargoDeLaDecision1795000000007 implements MigrationInterface {
  name = 'LargoDeLaDecision1795000000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "document_reading" ADD CONSTRAINT "CHK_document_reading_decision_note_length" CHECK ("decision_note" IS NULL OR char_length("decision_note") <= 500)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "document_reading" DROP CONSTRAINT "CHK_document_reading_decision_note_length"`,
    );
  }
}
