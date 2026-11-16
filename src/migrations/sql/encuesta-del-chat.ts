/**
 * Encuesta de satisfacción al cerrar (4b). Lo comparten la migración
 * `EncuestaYAccionesDelChat` y el arranque de las pruebas de integración.
 *
 * `conversation_rating_de_la_conversacion` (trigger `TRG_conversation_rating`):
 * la encuesta es de una conversación con un cliente, la responde SU cliente y
 * la pide el mensaje `csat_request` de esa misma conversación. Una vez
 * respondida, no cambia (respuesta única).
 */
export const CREAR_ENCUESTA_DEL_CHAT: readonly string[] = [
  `CREATE FUNCTION conversation_rating_de_la_conversacion() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF TG_OP = 'UPDATE' AND OLD."answered_at" IS NOT NULL THEN
       RAISE EXCEPTION 'La encuesta ya se respondió: no se cambia'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_conversation_rating_unica';
     END IF;
     IF TG_OP = 'UPDATE' AND (
          NEW."conversation_id" IS DISTINCT FROM OLD."conversation_id"
          OR NEW."distributor_id" IS DISTINCT FROM OLD."distributor_id"
          OR NEW."request_message_id" IS DISTINCT FROM OLD."request_message_id"
          OR NEW."customer_user_id" IS DISTINCT FROM OLD."customer_user_id"
          OR NEW."served_by" IS DISTINCT FROM OLD."served_by"
          OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at"
          OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at") THEN
       RAISE EXCEPTION 'De una encuesta sólo se guarda la respuesta'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_conversation_rating_unica';
     END IF;
     IF TG_OP = 'INSERT' AND NOT EXISTS (
          SELECT 1 FROM "conversation" c
            JOIN "message" m ON m."conversation_id" = c."conversation_id"
           WHERE c."conversation_id" = NEW."conversation_id"
             AND c."channel" = 'staff_customer'
             AND c."customer_user_id" = NEW."customer_user_id"
             AND m."message_id" = NEW."request_message_id"
             AND m."system_code" = 'csat_request') THEN
       RAISE EXCEPTION 'La encuesta es de una conversación con un cliente, de ese cliente y la pide su mensaje de encuesta'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_conversation_rating_conversacion';
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE TRIGGER "TRG_conversation_rating" BEFORE INSERT OR UPDATE ON "conversation_rating"
   FOR EACH ROW EXECUTE FUNCTION conversation_rating_de_la_conversacion()`,
];

export function sentenciasDeLaEncuesta(): string[] {
  return [...CREAR_ENCUESTA_DEL_CHAT];
}

export function sentenciasParaQuitarLaEncuesta(): string[] {
  return [
    `DROP TRIGGER IF EXISTS "TRG_conversation_rating" ON "conversation_rating"`,
    `DROP FUNCTION IF EXISTS conversation_rating_de_la_conversacion()`,
  ];
}

/**
 * Encuesta anulable (`EncuestaAnulableAlReabrir`): al reabrir la conversación,
 * la pendiente de ese cierre se anula (`cancelled_at`). Una encuesta se
 * responde o se anula, una sola vez; después no cambia. Reemplaza la función
 * de `CREAR_ENCUESTA_DEL_CHAT` (el trigger es el mismo).
 */
export const CREAR_ENCUESTA_ANULABLE: readonly string[] = [
  `CREATE OR REPLACE FUNCTION conversation_rating_de_la_conversacion() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF TG_OP = 'UPDATE' AND (OLD."answered_at" IS NOT NULL OR OLD."cancelled_at" IS NOT NULL) THEN
       RAISE EXCEPTION 'La encuesta ya se respondió o se anuló: no se cambia'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_conversation_rating_unica';
     END IF;
     IF TG_OP = 'UPDATE' AND (
          NEW."conversation_id" IS DISTINCT FROM OLD."conversation_id"
          OR NEW."distributor_id" IS DISTINCT FROM OLD."distributor_id"
          OR NEW."request_message_id" IS DISTINCT FROM OLD."request_message_id"
          OR NEW."customer_user_id" IS DISTINCT FROM OLD."customer_user_id"
          OR NEW."served_by" IS DISTINCT FROM OLD."served_by"
          OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at"
          OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at") THEN
       RAISE EXCEPTION 'De una encuesta sólo se guarda la respuesta o la anulación'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_conversation_rating_unica';
     END IF;
     IF TG_OP = 'INSERT' AND (NEW."answered_at" IS NOT NULL OR NEW."cancelled_at" IS NOT NULL OR NOT EXISTS (
          SELECT 1 FROM "conversation" c
            JOIN "message" m ON m."conversation_id" = c."conversation_id"
           WHERE c."conversation_id" = NEW."conversation_id"
             AND c."channel" = 'staff_customer'
             AND c."customer_user_id" = NEW."customer_user_id"
             AND m."message_id" = NEW."request_message_id"
             AND m."system_code" = 'csat_request')) THEN
       RAISE EXCEPTION 'La encuesta es de una conversación con un cliente, de ese cliente, la pide su mensaje de encuesta y nace pendiente'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_conversation_rating_conversacion';
     END IF;
     RETURN NEW;
   END $$`,
];

export function sentenciasDeLaEncuestaAnulable(): string[] {
  return [...CREAR_ENCUESTA_ANULABLE];
}
