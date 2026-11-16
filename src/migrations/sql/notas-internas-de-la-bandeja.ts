import { CREAR_MENSAJES_EDITABLES } from './bandeja-de-la-empresa';

/**
 * Notas internas de la bandeja con @menciones (4a, y la nota de derivación
 * del asistente con IA, 4c). Lo comparten la migración
 * `NotasInternasDeLaBandeja` y el arranque de las pruebas de integración
 * (después de `sql/mensajes-retirados.ts`).
 *
 * 1. `message_segun_el_canal` (trigger `TRG_message_canal`): una nota interna
 *    la deja la plataforma en el hilo de un ticket (D-C8), el personal en la
 *    bandeja (C3, C2) o el asistente al derivar (`handoff_note`, sólo C3). La
 *    cita de mensajes sigue sólo en un ticket.
 * 2. `message_mention_de_la_empresa` (trigger `TRG_message_mention`): la
 *    mención es de alguien del personal de la empresa de la nota, y la nota es
 *    una nota interna del personal en la bandeja. Que atienda el canal lo
 *    controla el servicio (es del rol, que puede cambiar después).
 */
export const CREAR_NOTAS_INTERNAS_DE_LA_BANDEJA: readonly string[] = [
  `CREATE OR REPLACE FUNCTION message_segun_el_canal() RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE
     canal text;
   BEGIN
     SELECT "channel" INTO canal FROM "conversation"
      WHERE "conversation_id" = NEW."conversation_id";
     IF NEW."visibility" = 'internal' AND NOT (
          (canal = 'platform_ticket' AND NEW."sender_party" = 'platform')
          OR (canal IN ('staff_customer', 'staff_driver') AND NEW."sender_party" = 'company')
          OR (canal = 'staff_customer' AND NEW."sender_party" = 'system'
              AND NEW."system_code" = 'handoff_note')) THEN
       RAISE EXCEPTION 'Las notas internas sólo las deja el equipo: en un ticket o en la bandeja de mensajes'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_message_canal';
     END IF;
     IF NEW."kind" = 'quoted_excerpt' AND canal IS DISTINCT FROM 'platform_ticket' THEN
       RAISE EXCEPTION 'Las citas sólo van en el hilo de un ticket'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_message_canal';
     END IF;
     IF NEW."reply_to_seq" IS NOT NULL
        AND canal NOT IN ('staff_customer', 'staff_driver') THEN
       RAISE EXCEPTION 'Responder a un mensaje sólo se puede en la bandeja de la empresa'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_message_canal';
     END IF;
     IF (NEW."sender_party" = 'platform' AND canal NOT IN ('platform_chat', 'platform_ticket'))
        OR (NEW."sender_party" = 'customer' AND canal IS DISTINCT FROM 'staff_customer')
        OR (NEW."sender_party" = 'driver' AND canal IS DISTINCT FROM 'staff_driver') THEN
       RAISE EXCEPTION 'Esa punta no escribe en este canal'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_message_canal';
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE FUNCTION message_mention_de_la_empresa() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NOT EXISTS (
          SELECT 1 FROM "message" m
            JOIN "conversation" c ON c."conversation_id" = m."conversation_id"
           WHERE m."message_id" = NEW."message_id"
             AND m."conversation_id" = NEW."conversation_id"
             AND m."visibility" = 'internal' AND m."sender_party" = 'company'
             AND c."channel" IN ('staff_customer', 'staff_driver')) THEN
       RAISE EXCEPTION 'Sólo se menciona a alguien en una nota interna de la bandeja'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_message_mention_nota';
     END IF;
     IF NOT EXISTS (
          SELECT 1 FROM "admin" a
           WHERE a."user_id" = NEW."mentioned_user_id"
             AND a."distributor_id" = NEW."distributor_id") THEN
       RAISE EXCEPTION 'La persona mencionada tiene que ser del personal de la empresa'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_message_mention_personal';
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE TRIGGER "TRG_message_mention" BEFORE INSERT OR UPDATE OF "message_id", "conversation_id", "distributor_id", "mentioned_user_id" ON "message_mention"
   FOR EACH ROW EXECUTE FUNCTION message_mention_de_la_empresa()`,
];

export function sentenciasDeNotasInternas(): string[] {
  return [...CREAR_NOTAS_INTERNAS_DE_LA_BANDEJA];
}

/**
 * Antes de deshacer: si ya hay notas internas del personal o del asistente,
 * menciones o avisos dirigidos a una persona, se frena con un mensaje claro.
 *
 * No se convierten ni se borran: volverlas visibles le mostraría al cliente
 * o al chofer lo que el equipo escribió para sí; darlas de baja (`deleted_at`)
 * no alcanza, porque el CHECK viejo mira todas las filas; y borrarlas de
 * verdad está prohibido (los mensajes no se borran, `CHK_message_inmutable`).
 * Sacar la columna del destinatario dejaría esos avisos a la vista de todos
 * los admins. Deshacer es para una base sin uso de la función; con datos, se
 * corrige hacia adelante con una migración nueva.
 */
export const FRENAR_SI_HAY_NOTAS = `DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "message"
              WHERE "visibility" = 'internal' AND "sender_party" IN ('company', 'system'))
     OR EXISTS (SELECT 1 FROM "message_mention")
     OR EXISTS (SELECT 1 FROM "admin_notification" WHERE "recipient_user_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'No se puede deshacer NotasInternasDeLaBandeja: ya hay notas internas de la bandeja, menciones o avisos para una persona. Volverlas visibles las mostraría a la otra punta y los mensajes no se borran; corregí hacia adelante con una migración nueva.'
      USING ERRCODE = '55000';
  END IF;
END $$`;

/** Vuelve a la función de la bandeja (notas internas sólo en un ticket). */
export function sentenciasParaQuitarNotasInternas(): string[] {
  return [
    `DROP TRIGGER IF EXISTS "TRG_message_mention" ON "message_mention"`,
    `DROP FUNCTION IF EXISTS message_mention_de_la_empresa()`,
    ...CREAR_MENSAJES_EDITABLES.filter((s) =>
      s.includes('FUNCTION message_segun_el_canal()'),
    ),
  ];
}
