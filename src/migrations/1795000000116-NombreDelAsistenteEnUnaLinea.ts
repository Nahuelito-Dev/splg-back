import { MigrationInterface, QueryRunner } from 'typeorm';

const ANTES = `"assistant_name" IS NULL OR (char_length(btrim("assistant_name")) BETWEEN 2 AND 60 AND "assistant_name" !~ '[[:cntrl:]]')`;
const AHORA = `"assistant_name" IS NULL OR (char_length(btrim("assistant_name")) BETWEEN 2 AND 60 AND "assistant_name" !~ '[\\u0001-\\u001F\\u007F-\\u009F\\u2028\\u2029]')`;

/**
 * El nombre del asistente en una sola línea, con la misma regla que el DTO y
 * el dominio (`nombreDelAsistenteValido`): sin controles C0/C1 (explícitos, no
 * dependen del locale de `[[:cntrl:]]`) ni los separadores de línea y de
 * párrafo U+2028/U+2029. El largo ya se contaba en caracteres (`char_length`).
 *
 * TypeORM no compara el texto de los CHECK: esta migración va escrita a mano.
 */
export class NombreDelAsistenteEnUnaLinea1795000000116
  implements MigrationInterface
{
  name = 'NombreDelAsistenteEnUnaLinea1795000000116';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" DROP CONSTRAINT "CHK_chat_company_settings_asistente"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" ADD CONSTRAINT "CHK_chat_company_settings_asistente" CHECK (${AHORA})`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" DROP CONSTRAINT "CHK_chat_company_settings_asistente"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" ADD CONSTRAINT "CHK_chat_company_settings_asistente" CHECK (${ANTES})`,
    );
  }
}
