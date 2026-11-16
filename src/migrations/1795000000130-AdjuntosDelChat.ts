import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  sentenciasDeAdjuntosDelChat,
  sentenciasParaQuitarAdjuntosDelChat,
} from './sql/adjuntos-del-chat';

/** Los tipos que acepta algún canal del chat (`TIPOS_DEL_CHAT`). */
const TIPOS_DEL_CHAT = `'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv'`;

/**
 * Adjuntos del chat (CH7, diseño §6.6 y §9):
 *
 * 1. `attachment`: `message_id` (sólo `chat_message`, igual a `owner_id`) con
 *    FK compuesta `(message_id, distributor_id)` a `message` (un adjunto no
 *    puede ser de un mensaje de otra empresa) y único (uno por mensaje,
 *    D-C13); `scan_status` (`not_required` para los de siempre), `scanned_at`
 *    y las medidas de la foto. CHECK: estado válido, tipos y tope de 10 MB del
 *    chat, foto siempre `clean`, medidas sólo de fotos.
 * 2. `message`: `kind = 'attachment'` (epígrafe opcional de hasta 500 y
 *    `payload.media` foto o archivo, salvo redactado; con `client_message_id`).
 * 3. Triggers de `sql/adjuntos-del-chat.ts`: quién sube y de qué mensaje, el
 *    escaneo que sólo avanza, el mensaje que no queda sin adjunto y la baja de
 *    los adjuntos al redactar.
 *
 * Los adjuntos que ya existen quedan igual (`message_id` nulo, `not_required`).
 */
export class AdjuntosDelChat1795000000130 implements MigrationInterface {
  name = 'AdjuntosDelChat1795000000130';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "attachment" ADD "message_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "attachment" ADD "scan_status" character varying(15) NOT NULL DEFAULT 'not_required'`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" ADD "scanned_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(`ALTER TABLE "attachment" ADD "width" integer`);
    await queryRunner.query(`ALTER TABLE "attachment" ADD "height" integer`);
    await queryRunner.query(
      `ALTER TABLE "attachment" ADD CONSTRAINT "CHK_attachment_escaneo_estado" CHECK ("scan_status" IN ('not_required', 'pending', 'clean', 'infected', 'failed'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" ADD CONSTRAINT "CHK_attachment_chat_mensaje" CHECK (("owner_type"::text = 'chat_message') = ("message_id" IS NOT NULL) AND ("message_id" IS NULL OR "message_id" = "owner_id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" ADD CONSTRAINT "CHK_attachment_chat_escaneo" CHECK (("message_id" IS NOT NULL) = ("scan_status" <> 'not_required'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" ADD CONSTRAINT "CHK_attachment_foto_limpia" CHECK ("message_id" IS NULL OR "mime_type" NOT LIKE 'image/%' OR "scan_status" = 'clean')`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" ADD CONSTRAINT "CHK_attachment_chat_tipo" CHECK ("message_id" IS NULL OR "mime_type" IN (${TIPOS_DEL_CHAT}))`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" ADD CONSTRAINT "CHK_attachment_chat_tamano" CHECK ("message_id" IS NULL OR "size_bytes" BETWEEN 1 AND 10485760)`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" ADD CONSTRAINT "CHK_attachment_medidas" CHECK (("width" IS NULL) = ("height" IS NULL) AND ("width" IS NULL OR ("width" > 0 AND "height" > 0 AND "mime_type" LIKE 'image/%')))`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" ADD CONSTRAINT "CHK_attachment_escaneado" CHECK ("scanned_at" IS NULL OR "scan_status" IN ('clean', 'infected', 'failed'))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_attachment_mensaje" ON "attachment" ("message_id") WHERE "message_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_attachment_escaneo_pendiente" ON "attachment" ("uploaded_at") WHERE "scan_status" = 'pending'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_attachment_chat_cupo" ON "attachment" ("distributor_id", "uploaded_by_user_id", "uploaded_at") WHERE "message_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" ADD CONSTRAINT "FK_attachment_message_distribuidora" FOREIGN KEY ("message_id", "distributor_id") REFERENCES "message"("message_id", "distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `ALTER TABLE "message" DROP CONSTRAINT "CHK_message_tipo"`,
    );
    await queryRunner.query(
      `ALTER TABLE "message" ADD CONSTRAINT "CHK_message_tipo" CHECK ("kind" IN ('text', 'system', 'auto_reply', 'quoted_excerpt', 'attachment') AND ("kind" IN ('system', 'auto_reply')) = ("sender_party" = 'system'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "message" ADD CONSTRAINT "CHK_message_adjunto" CHECK ("kind" <> 'attachment' OR ("client_message_id" IS NOT NULL AND ("body" IS NULL OR char_length("body") <= 500) AND ("redacted_at" IS NOT NULL OR "payload" ->> 'media' IN ('photo', 'file'))))`,
    );

    for (const sentencia of sentenciasDeAdjuntosDelChat()) {
      await queryRunner.query(sentencia);
    }
  }

  /** Aborta si ya hay mensajes de adjunto: el CHECK viejo no los admite y los mensajes no se borran. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const filas: unknown = await queryRunner.query(
      `SELECT count(*) AS n FROM "message" WHERE "kind" = 'attachment'`,
    );
    const [uso] = filas as Array<{ n: string }>;
    if (Number(uso?.n ?? 0) > 0) {
      throw new Error(
        `No se puede revertir AdjuntosDelChat: hay ${uso.n} mensajes con adjunto y los mensajes no se borran; corregí hacia adelante con una migración nueva`,
      );
    }
    for (const sentencia of sentenciasParaQuitarAdjuntosDelChat()) {
      await queryRunner.query(sentencia);
    }
    await queryRunner.query(
      `ALTER TABLE "message" DROP CONSTRAINT "CHK_message_adjunto"`,
    );
    await queryRunner.query(
      `ALTER TABLE "message" DROP CONSTRAINT "CHK_message_tipo"`,
    );
    await queryRunner.query(
      `ALTER TABLE "message" ADD CONSTRAINT "CHK_message_tipo" CHECK ("kind" IN ('text', 'system', 'auto_reply', 'quoted_excerpt') AND ("kind" IN ('system', 'auto_reply')) = ("sender_party" = 'system'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" DROP CONSTRAINT "FK_attachment_message_distribuidora"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_attachment_chat_cupo"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_attachment_escaneo_pendiente"`,
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_attachment_mensaje"`);
    for (const chk of [
      'CHK_attachment_escaneado',
      'CHK_attachment_medidas',
      'CHK_attachment_chat_tamano',
      'CHK_attachment_chat_tipo',
      'CHK_attachment_foto_limpia',
      'CHK_attachment_chat_escaneo',
      'CHK_attachment_chat_mensaje',
      'CHK_attachment_escaneo_estado',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "attachment" DROP CONSTRAINT "${chk}"`,
      );
    }
    await queryRunner.query(`ALTER TABLE "attachment" DROP COLUMN "height"`);
    await queryRunner.query(`ALTER TABLE "attachment" DROP COLUMN "width"`);
    await queryRunner.query(
      `ALTER TABLE "attachment" DROP COLUMN "scanned_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" DROP COLUMN "scan_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" DROP COLUMN "message_id"`,
    );
  }
}
