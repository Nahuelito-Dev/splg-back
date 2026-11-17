/**
 * Adjuntos del chat (CH7). Lo comparten la migración `AdjuntosDelChat` y el
 * arranque de las pruebas de integración (después de `sql/encuesta-del-chat.ts`).
 * Los CHECK y la FK compuesta `(message_id, distributor_id)` están en la
 * entidad y en la migración; acá, lo que mira otras filas:
 *
 * 1. `attachment_del_chat` (`TRG_attachment_chat`): el adjunto de un mensaje
 *    es de un mensaje de adjunto (`kind = 'attachment'`), visible y sin
 *    redactar, y lo sube quien escribió el mensaje. Un PDF o documento nace
 *    `pending` (lo tiene que ver el escáner); una foto, `clean` (CHECK).
 * 2. `attachment_escaneo` (`TRG_attachment_escaneo`): el escaneo sólo avanza
 *    de `pending` a `clean`, `infected` o `failed`, y una vez.
 * 3. `message_con_adjunto` (`TRG_message_adjunto`, diferido al commit): un
 *    mensaje de adjunto no queda sin su adjunto (los dos van en la misma
 *    transacción).
 * 4. `message_redactado_sin_adjuntos` (`TRG_message_redactado`): al redactar
 *    un mensaje (retención, §10.4), su adjunto se da de baja (lógica) y la key
 *    va a `storage_orphan` para que el cron borre el objeto de S3.
 */
export const CREAR_ADJUNTOS_DEL_CHAT: readonly string[] = [
  `CREATE FUNCTION attachment_del_chat() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NOT EXISTS (
          SELECT 1 FROM "message" m
           WHERE m."message_id" = NEW."message_id"
             AND m."distributor_id" = NEW."distributor_id"
             AND m."kind" = 'attachment'
             AND m."visibility" = 'all'
             AND m."sender_user_id" = NEW."uploaded_by_user_id"
             AND (TG_OP = 'UPDATE' OR m."redacted_at" IS NULL)) THEN
       RAISE EXCEPTION 'El adjunto del chat es de un mensaje de adjunto de quien lo sube'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_attachment_mensaje_del_chat';
     END IF;
     IF TG_OP = 'INSERT' AND NEW."mime_type" NOT LIKE 'image/%'
        AND NEW."scan_status" <> 'pending' THEN
       RAISE EXCEPTION 'Un archivo del chat queda pendiente hasta que lo revise el antivirus'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_attachment_escaneo_inicial';
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE TRIGGER "TRG_attachment_chat" BEFORE INSERT OR UPDATE OF "message_id", "owner_id", "distributor_id", "uploaded_by_user_id" ON "attachment"
   FOR EACH ROW WHEN (NEW."message_id" IS NOT NULL) EXECUTE FUNCTION attachment_del_chat()`,
  `CREATE FUNCTION attachment_escaneo() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NEW."scan_status" IS DISTINCT FROM OLD."scan_status" AND NOT (
          OLD."scan_status" = 'pending'
          AND NEW."scan_status" IN ('clean', 'infected', 'failed')) THEN
       RAISE EXCEPTION 'El escaneo de un archivo sólo pasa de pendiente a limpio, infectado o fallido'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_attachment_escaneo_transicion';
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE TRIGGER "TRG_attachment_escaneo" BEFORE UPDATE OF "scan_status" ON "attachment"
   FOR EACH ROW EXECUTE FUNCTION attachment_escaneo()`,
  `CREATE FUNCTION message_con_adjunto() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NOT EXISTS (
          SELECT 1 FROM "attachment" a
           WHERE a."message_id" = NEW."message_id"
             AND a."distributor_id" = NEW."distributor_id") THEN
       RAISE EXCEPTION 'Un mensaje de adjunto se guarda con su archivo'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_message_sin_adjunto';
     END IF;
     RETURN NULL;
   END $$`,
  `CREATE CONSTRAINT TRIGGER "TRG_message_adjunto" AFTER INSERT ON "message"
   DEFERRABLE INITIALLY DEFERRED
   FOR EACH ROW WHEN (NEW."kind" = 'attachment') EXECUTE FUNCTION message_con_adjunto()`,
  `CREATE FUNCTION message_redactado_sin_adjuntos() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     WITH bajas AS (
       UPDATE "attachment" SET "deleted_at" = now()
        WHERE "message_id" = NEW."message_id" AND "deleted_at" IS NULL
       RETURNING "storage_key")
     INSERT INTO "storage_orphan" ("storage_key", "kind", "status", "next_attempt_at")
     SELECT "storage_key", 'remove', 'pending', now() FROM bajas
     ON CONFLICT ("storage_key") DO UPDATE
        SET "kind" = 'remove', "status" = 'pending', "attempts" = 0,
            "next_attempt_at" = now(), "updated_at" = now();
     RETURN NULL;
   END $$`,
  `CREATE TRIGGER "TRG_message_redactado" AFTER UPDATE OF "redacted_at" ON "message"
   FOR EACH ROW WHEN (OLD."redacted_at" IS NULL AND NEW."redacted_at" IS NOT NULL)
   EXECUTE FUNCTION message_redactado_sin_adjuntos()`,
];

export function sentenciasDeAdjuntosDelChat(): string[] {
  return [...CREAR_ADJUNTOS_DEL_CHAT];
}

export function sentenciasParaQuitarAdjuntosDelChat(): string[] {
  return [
    `DROP TRIGGER IF EXISTS "TRG_message_redactado" ON "message"`,
    `DROP FUNCTION IF EXISTS message_redactado_sin_adjuntos()`,
    `DROP TRIGGER IF EXISTS "TRG_message_adjunto" ON "message"`,
    `DROP FUNCTION IF EXISTS message_con_adjunto()`,
    `DROP TRIGGER IF EXISTS "TRG_attachment_escaneo" ON "attachment"`,
    `DROP FUNCTION IF EXISTS attachment_escaneo()`,
    `DROP TRIGGER IF EXISTS "TRG_attachment_chat" ON "attachment"`,
    `DROP FUNCTION IF EXISTS attachment_del_chat()`,
  ];
}
