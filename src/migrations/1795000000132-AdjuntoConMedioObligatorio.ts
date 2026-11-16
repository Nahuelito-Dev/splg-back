import { MigrationInterface, QueryRunner } from 'typeorm';

const ANTES = `"kind" <> 'attachment' OR ("client_message_id" IS NOT NULL AND ("body" IS NULL OR char_length("body") <= 500) AND ("redacted_at" IS NOT NULL OR "payload" ->> 'media' IN ('photo', 'file')))`;
const AHORA = `"kind" <> 'attachment' OR ("client_message_id" IS NOT NULL AND ("body" IS NULL OR char_length("body") <= 500) AND ("redacted_at" IS NOT NULL OR coalesce("payload" ->> 'media', '') IN ('photo', 'file')))`;

/**
 * `CHK_message_adjunto` (de `AdjuntosDelChat`) dejaba pasar un mensaje de
 * adjunto sin `payload.media`: `payload ->> 'media'` es nulo, el `IN` da nulo
 * y un CHECK nulo no rechaza. Con `coalesce` el medio pasa a ser obligatorio
 * (foto o archivo) mientras el mensaje no esté redactado.
 */
export class AdjuntoConMedioObligatorio1795000000132
  implements MigrationInterface
{
  name = 'AdjuntoConMedioObligatorio1795000000132';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "message" DROP CONSTRAINT "CHK_message_adjunto"`,
    );
    await queryRunner.query(
      `ALTER TABLE "message" ADD CONSTRAINT "CHK_message_adjunto" CHECK (${AHORA})`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "message" DROP CONSTRAINT "CHK_message_adjunto"`,
    );
    await queryRunner.query(
      `ALTER TABLE "message" ADD CONSTRAINT "CHK_message_adjunto" CHECK (${ANTES})`,
    );
  }
}
