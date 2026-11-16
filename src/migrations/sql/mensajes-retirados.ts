import { CREAR_MENSAJES_EDITABLES } from './bandeja-de-la-empresa';

/**
 * Borrar un mensaje propio (D-C23, CH3): el cliente retira su mensaje en C3.
 * Lo comparten la migración `BorradoDeMensajesPropios` y el arranque de las
 * pruebas de integración (después de `sql/bandeja-de-la-empresa.ts`).
 *
 * `message_inmutable` suma el retiro a lo que se puede cambiar de un mensaje:
 * una sola vez (no se «des-borra»), del texto de un cliente, por él mismo y en
 * una conversación con la empresa (C3). Un mensaje retirado ya no se edita. El
 * texto queda en la fila hasta que la retención lo redacte (CH8: el proceso
 * diario de §10.4 pone `body = NULL` y `redacted_at`; para los retirados puede
 * hacerlo antes, sin esperar el plazo del canal).
 */
export const CREAR_MENSAJES_RETIRABLES: readonly string[] = [
  `CREATE OR REPLACE FUNCTION message_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE
     libres text[] := ARRAY['body', 'payload', 'redacted_at', 'deleted_at', 'edited_at', 'withdrawn_at', 'withdrawn_by_user_id'];
     canal text;
     edicion boolean;
     retiro boolean;
   BEGIN
     IF TG_OP = 'DELETE' THEN
       RAISE EXCEPTION 'Los mensajes no se borran: se redactan o se dan de baja'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_message_inmutable';
     END IF;
     SELECT "channel" INTO canal FROM "conversation"
      WHERE "conversation_id" = NEW."conversation_id";
     -- Una edición (D-C22): texto nuevo con la marca nueva, de un texto sin
     -- redactar ni retirar, en la bandeja de la empresa.
     edicion := NEW."edited_at" IS NOT NULL
       AND NEW."edited_at" IS DISTINCT FROM OLD."edited_at"
       AND NEW."body" IS NOT NULL
       AND OLD."redacted_at" IS NULL AND NEW."redacted_at" IS NULL
       AND OLD."withdrawn_at" IS NULL AND NEW."withdrawn_at" IS NULL
       AND canal IN ('staff_customer', 'staff_driver');
     -- Un retiro (D-C23): una sola vez, del cliente que lo escribió, en C3.
     retiro := OLD."withdrawn_at" IS NULL AND NEW."withdrawn_at" IS NOT NULL
       AND NEW."withdrawn_by_user_id" = OLD."sender_user_id"
       AND OLD."sender_party" = 'customer'
       AND canal = 'staff_customer';
     IF (to_jsonb(NEW) - libres) IS DISTINCT FROM (to_jsonb(OLD) - libres)
        OR (NEW."edited_at" IS DISTINCT FROM OLD."edited_at" AND NOT edicion)
        OR ((NEW."withdrawn_at" IS DISTINCT FROM OLD."withdrawn_at"
             OR NEW."withdrawn_by_user_id" IS DISTINCT FROM OLD."withdrawn_by_user_id") AND NOT retiro)
        OR (NEW."body" IS DISTINCT FROM OLD."body" AND NOT edicion AND (NEW."body" IS NOT NULL OR NEW."redacted_at" IS NULL))
        OR (NEW."payload" IS DISTINCT FROM OLD."payload" AND (NEW."payload" IS NOT NULL OR NEW."redacted_at" IS NULL))
        OR (OLD."redacted_at" IS NOT NULL AND NEW."redacted_at" IS DISTINCT FROM OLD."redacted_at") THEN
       RAISE EXCEPTION 'Un mensaje no se edita: sólo su autor, en la bandeja de la empresa; si no, sólo se redacta o se da de baja'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_message_inmutable';
     END IF;
     RETURN NEW;
   END $$`,
];

export function sentenciasDeMensajesRetirados(): string[] {
  return [...CREAR_MENSAJES_RETIRABLES];
}

/** Vuelve a la función de la bandeja (sin el retiro). */
export function sentenciasParaQuitarMensajesRetirados(): string[] {
  return [CREAR_MENSAJES_EDITABLES[0]];
}
