import {
  crearFuncionDeTransicion,
  crearTriggerDeTransicion,
  type MaquinaDeEstado,
  quitarTriggerDeTransicion,
} from './transiciones-de-estado';

/**
 * Mensajería (CH1: chat con la plataforma y tickets): lo que la base asegura
 * además de las columnas, los CHECK y las claves foráneas de las entidades.
 * Lo comparten la migración `Mensajeria` y el arranque de las pruebas de
 * integración (que sincronizan el esquema desde las entidades).
 *
 *  - Un solo chat abierto por empresa y una clave de plantilla vigente
 *    (únicos parciales).
 *  - Numeración global de los tickets (`T-000123`).
 *  - Partes válidas de cada conversación (trigger diferido: se controla al
 *    confirmar, cuando ya se cargaron las dos).
 *  - Mensajes inmutables: sólo se redactan o se dan de baja; nunca se editan
 *    ni se borran.
 *  - Notas internas y citas sólo en el hilo de un ticket.
 *  - El hilo de un ticket es `platform_ticket` y su chat de origen,
 *    `platform_chat`.
 *  - Transiciones del ticket: copia congelada de la máquina del dominio
 *    (`support-ticket.machine.spec` verifica que coinciden).
 */
export const MAQUINA_DEL_TICKET: MaquinaDeEstado = {
  tabla: 'support_ticket',
  columna: 'status',
  etiqueta: 'El ticket',
  transiciones: {
    new: ['open', 'waiting_company'],
    open: ['waiting_company', 'resolved'],
    waiting_company: ['open', 'resolved', 'closed'],
    resolved: ['open', 'closed'],
    closed: [],
  },
};

export const SECUENCIA_DE_TICKETS = 'support_ticket_number_seq';

export const CREAR_INDICES_DE_MENSAJERIA: readonly string[] = [
  `CREATE UNIQUE INDEX "UQ_conversation_general_abierta" ON "conversation" ("distributor_id", "channel") WHERE "subject_type" = 'general' AND "status" = 'open' AND "deleted_at" IS NULL`,
  `CREATE UNIQUE INDEX "UQ_message_template_clave_vigente" ON "message_template" (COALESCE("distributor_id", '00000000-0000-0000-0000-000000000000'::uuid), "scope", "key") WHERE "deleted_at" IS NULL`,
  `CREATE SEQUENCE IF NOT EXISTS "${SECUENCIA_DE_TICKETS}" AS integer START 1`,
];

export const CREAR_PARTES_VALIDAS: readonly string[] = [
  `CREATE FUNCTION conversation_partes_validas() RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE
     partes text[];
   BEGIN
     SELECT array_agg("party"::text ORDER BY "party") INTO partes
       FROM "conversation_party" WHERE "conversation_id" = NEW."conversation_id";
     IF partes IS DISTINCT FROM ARRAY['company', 'platform']::text[] THEN
       RAISE EXCEPTION 'La conversación no tiene las partes de su canal'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_conversation_partes';
     END IF;
     RETURN NULL;
   END $$`,
  `CREATE CONSTRAINT TRIGGER "TRG_conversation_partes" AFTER INSERT ON "conversation"
   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION conversation_partes_validas()`,
];

export const CREAR_MENSAJES_INMUTABLES: readonly string[] = [
  `CREATE FUNCTION message_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE
     libres text[] := ARRAY['body', 'payload', 'redacted_at', 'deleted_at'];
   BEGIN
     IF TG_OP = 'DELETE' THEN
       RAISE EXCEPTION 'Los mensajes no se borran: se redactan o se dan de baja'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_message_inmutable';
     END IF;
     IF (to_jsonb(NEW) - libres) IS DISTINCT FROM (to_jsonb(OLD) - libres)
        OR (NEW."body" IS DISTINCT FROM OLD."body" AND (NEW."body" IS NOT NULL OR NEW."redacted_at" IS NULL))
        OR (NEW."payload" IS DISTINCT FROM OLD."payload" AND (NEW."payload" IS NOT NULL OR NEW."redacted_at" IS NULL))
        OR (OLD."redacted_at" IS NOT NULL AND NEW."redacted_at" IS DISTINCT FROM OLD."redacted_at") THEN
       RAISE EXCEPTION 'Un mensaje no se edita: sólo se redacta o se da de baja'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_message_inmutable';
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE TRIGGER "TRG_message_inmutable" BEFORE UPDATE OR DELETE ON "message"
   FOR EACH ROW EXECUTE FUNCTION message_inmutable()`,
];

export const CREAR_MENSAJES_SEGUN_EL_CANAL: readonly string[] = [
  `CREATE FUNCTION message_segun_el_canal() RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE
     canal text;
   BEGIN
     SELECT "channel" INTO canal FROM "conversation"
      WHERE "conversation_id" = NEW."conversation_id";
     IF (NEW."visibility" = 'internal' OR NEW."kind" = 'quoted_excerpt')
        AND canal IS DISTINCT FROM 'platform_ticket' THEN
       RAISE EXCEPTION 'Las notas internas y las citas sólo van en el hilo de un ticket'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_message_canal';
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE TRIGGER "TRG_message_canal" BEFORE INSERT ON "message"
   FOR EACH ROW EXECUTE FUNCTION message_segun_el_canal()`,
];

export const CREAR_CANALES_DEL_TICKET: readonly string[] = [
  `CREATE FUNCTION support_ticket_canales() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM "conversation"
                     WHERE "conversation_id" = NEW."conversation_id"
                       AND "channel" = 'platform_ticket')
        OR (NEW."origin_conversation_id" IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM "conversation"
               WHERE "conversation_id" = NEW."origin_conversation_id"
                 AND "channel" = 'platform_chat')) THEN
       RAISE EXCEPTION 'El hilo de un ticket es un hilo de ticket y su origen, el chat con la plataforma'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_support_ticket_canales';
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE TRIGGER "TRG_support_ticket_canales" BEFORE INSERT OR UPDATE OF "conversation_id", "origin_conversation_id" ON "support_ticket"
   FOR EACH ROW EXECUTE FUNCTION support_ticket_canales()`,
];

export function sentenciasDeMensajeria(): string[] {
  return [
    ...CREAR_INDICES_DE_MENSAJERIA,
    ...CREAR_PARTES_VALIDAS,
    ...CREAR_MENSAJES_INMUTABLES,
    ...CREAR_MENSAJES_SEGUN_EL_CANAL,
    ...CREAR_CANALES_DEL_TICKET,
    crearFuncionDeTransicion(MAQUINA_DEL_TICKET),
    crearTriggerDeTransicion(MAQUINA_DEL_TICKET),
  ];
}

export function sentenciasParaQuitarMensajeria(): string[] {
  return [
    ...quitarTriggerDeTransicion(MAQUINA_DEL_TICKET),
    `DROP TRIGGER IF EXISTS "TRG_support_ticket_canales" ON "support_ticket"`,
    `DROP FUNCTION IF EXISTS support_ticket_canales()`,
    `DROP TRIGGER IF EXISTS "TRG_message_canal" ON "message"`,
    `DROP FUNCTION IF EXISTS message_segun_el_canal()`,
    `DROP TRIGGER IF EXISTS "TRG_message_inmutable" ON "message"`,
    `DROP FUNCTION IF EXISTS message_inmutable()`,
    `DROP TRIGGER IF EXISTS "TRG_conversation_partes" ON "conversation"`,
    `DROP FUNCTION IF EXISTS conversation_partes_validas()`,
    `DROP SEQUENCE IF EXISTS "${SECUENCIA_DE_TICKETS}"`,
    `DROP INDEX IF EXISTS "UQ_message_template_clave_vigente"`,
    `DROP INDEX IF EXISTS "UQ_conversation_general_abierta"`,
  ];
}
