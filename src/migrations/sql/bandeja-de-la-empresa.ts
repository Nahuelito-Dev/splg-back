import {
  CREAR_MENSAJES_INMUTABLES,
  CREAR_MENSAJES_SEGUN_EL_CANAL,
  CREAR_PARTES_VALIDAS,
} from './mensajeria';

/**
 * Mensajería, etapa CH3 (bandeja de la empresa: C3 clientes y C2 choferes): lo
 * que la base asegura además de las columnas, los CHECK y las claves foráneas
 * de las entidades. Lo comparten la migración `BandejaDeLaEmpresa` y el
 * arranque de las pruebas de integración (después de `sql/mensajeria.ts`).
 *
 *  - Una conversación general abierta por persona y canal (también una por
 *    empresa en el chat con la plataforma, con la persona nula) y una abierta
 *    por pedido y canal (únicos parciales).
 *  - Partes válidas por canal (trigger diferido de CH1, ahora por canal).
 *  - El chofer, el cliente y quien atiende son de la empresa de la
 *    conversación (el cliente: con vínculo o con un pedido con ella).
 *  - Mensajes: el texto propio se edita sólo en la bandeja (D-C22) y con
 *    `edited_at`; responder a otro mensaje (D-C25), sólo en la bandeja; cada
 *    punta escribe sólo en sus canales.
 *  - El historial de ediciones no se edita ni se borra (sólo se redacta).
 */
const NULO = `'00000000-0000-0000-0000-000000000000'::uuid`;

export const CREAR_INDICES_DE_LA_BANDEJA: readonly string[] = [
  `DROP INDEX IF EXISTS "UQ_conversation_general_abierta"`,
  `CREATE UNIQUE INDEX "UQ_conversation_general_abierta" ON "conversation" ("distributor_id", "channel", COALESCE("customer_user_id", "driver_user_id", ${NULO})) WHERE "subject_type" = 'general' AND "status" = 'open' AND "deleted_at" IS NULL`,
  `CREATE UNIQUE INDEX "UQ_conversation_pedido_abierta" ON "conversation" ("channel", "order_id") WHERE "subject_type" = 'order' AND "status" = 'open' AND "deleted_at" IS NULL`,
];

export const CREAR_PARTES_POR_CANAL: readonly string[] = [
  `CREATE OR REPLACE FUNCTION conversation_partes_validas() RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE
     partes text[];
     esperadas text[];
   BEGIN
     SELECT array_agg("party"::text ORDER BY "party") INTO partes
       FROM "conversation_party" WHERE "conversation_id" = NEW."conversation_id";
     esperadas := CASE NEW."channel"
       WHEN 'staff_customer' THEN ARRAY['company', 'customer']::text[]
       WHEN 'staff_driver' THEN ARRAY['company', 'driver']::text[]
       ELSE ARRAY['company', 'platform']::text[]
     END;
     IF partes IS DISTINCT FROM esperadas THEN
       RAISE EXCEPTION 'La conversación no tiene las partes de su canal'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_conversation_partes';
     END IF;
     IF NEW."channel" = 'staff_customer' AND NOT EXISTS (
          SELECT 1 FROM "conversation_party" p
           WHERE p."conversation_id" = NEW."conversation_id" AND p."party" = 'customer'
             AND p."user_id" = NEW."customer_user_id")
        OR NEW."channel" = 'staff_driver' AND NOT EXISTS (
          SELECT 1 FROM "conversation_party" p
           WHERE p."conversation_id" = NEW."conversation_id" AND p."party" = 'driver'
             AND p."user_id" = NEW."driver_user_id") THEN
       RAISE EXCEPTION 'La parte de la persona no es la persona de la conversación'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_conversation_partes';
     END IF;
     RETURN NULL;
   END $$`,
];

export const CREAR_PERSONAS_DE_LA_EMPRESA: readonly string[] = [
  `CREATE FUNCTION conversation_personas_de_la_empresa() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NEW."channel" NOT IN ('staff_customer', 'staff_driver') THEN
       RETURN NEW;
     END IF;
     IF NEW."assigned_to_user_id" IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW."assigned_to_user_id" IS DISTINCT FROM OLD."assigned_to_user_id")
        AND NOT EXISTS (
          SELECT 1 FROM "admin" a JOIN "user" u ON u."user_id" = a."user_id"
           WHERE a."user_id" = NEW."assigned_to_user_id"
             AND a."distributor_id" = NEW."distributor_id"
             AND u."deletedAt" IS NULL) THEN
       RAISE EXCEPTION 'Quien atiende la conversación tiene que ser del personal de la empresa'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_conversation_personas_de_la_empresa';
     END IF;
     IF NEW."driver_user_id" IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW."driver_user_id" IS DISTINCT FROM OLD."driver_user_id")
        AND NOT EXISTS (
          SELECT 1 FROM "delivery" d
           WHERE d."user_id" = NEW."driver_user_id"
             AND d."distributor_id" = NEW."distributor_id") THEN
       RAISE EXCEPTION 'El chofer tiene que ser de la empresa de la conversación'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_conversation_personas_de_la_empresa';
     END IF;
     IF NEW."customer_user_id" IS NOT NULL
        AND (TG_OP = 'INSERT' OR NEW."customer_user_id" IS DISTINCT FROM OLD."customer_user_id")
        AND NOT EXISTS (
          SELECT 1 FROM "customer_distributor" cd
           WHERE cd."user_id" = NEW."customer_user_id"
             AND cd."distributor_id" = NEW."distributor_id")
        AND NOT EXISTS (
          SELECT 1 FROM "order" o
           WHERE o."customer_id" = NEW."customer_user_id"
             AND o."distributor_id" = NEW."distributor_id") THEN
       RAISE EXCEPTION 'El cliente tiene que ser de la empresa de la conversación'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_conversation_personas_de_la_empresa';
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE TRIGGER "TRG_conversation_personas" BEFORE INSERT OR UPDATE OF "assigned_to_user_id", "driver_user_id", "customer_user_id" ON "conversation"
   FOR EACH ROW EXECUTE FUNCTION conversation_personas_de_la_empresa()`,
];

export const CREAR_MENSAJES_EDITABLES: readonly string[] = [
  `CREATE OR REPLACE FUNCTION message_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE
     libres text[] := ARRAY['body', 'payload', 'redacted_at', 'deleted_at', 'edited_at'];
     canal text;
     edicion boolean;
   BEGIN
     IF TG_OP = 'DELETE' THEN
       RAISE EXCEPTION 'Los mensajes no se borran: se redactan o se dan de baja'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_message_inmutable';
     END IF;
     -- Una edición (D-C22): texto nuevo con la marca nueva, de un texto sin
     -- redactar, en la bandeja de la empresa.
     edicion := NEW."edited_at" IS NOT NULL
       AND NEW."edited_at" IS DISTINCT FROM OLD."edited_at"
       AND NEW."body" IS NOT NULL
       AND OLD."redacted_at" IS NULL AND NEW."redacted_at" IS NULL;
     IF edicion THEN
       SELECT "channel" INTO canal FROM "conversation"
        WHERE "conversation_id" = NEW."conversation_id";
       IF canal IS DISTINCT FROM 'staff_customer' AND canal IS DISTINCT FROM 'staff_driver' THEN
         edicion := false;
       END IF;
     END IF;
     IF (to_jsonb(NEW) - libres) IS DISTINCT FROM (to_jsonb(OLD) - libres)
        OR (NEW."edited_at" IS DISTINCT FROM OLD."edited_at" AND NOT edicion)
        OR (NEW."body" IS DISTINCT FROM OLD."body" AND NOT edicion AND (NEW."body" IS NOT NULL OR NEW."redacted_at" IS NULL))
        OR (NEW."payload" IS DISTINCT FROM OLD."payload" AND (NEW."payload" IS NOT NULL OR NEW."redacted_at" IS NULL))
        OR (OLD."redacted_at" IS NOT NULL AND NEW."redacted_at" IS DISTINCT FROM OLD."redacted_at") THEN
       RAISE EXCEPTION 'Un mensaje no se edita: sólo su autor, en la bandeja de la empresa; si no, sólo se redacta o se da de baja'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_message_inmutable';
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE OR REPLACE FUNCTION message_segun_el_canal() RETURNS trigger LANGUAGE plpgsql AS $$
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
];

export const CREAR_HISTORIAL_INMUTABLE: readonly string[] = [
  `CREATE FUNCTION message_edit_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF TG_OP = 'DELETE'
        OR (to_jsonb(NEW) - 'previous_body') IS DISTINCT FROM (to_jsonb(OLD) - 'previous_body')
        OR NEW."previous_body" IS NOT NULL AND NEW."previous_body" IS DISTINCT FROM OLD."previous_body" THEN
       RAISE EXCEPTION 'El historial de ediciones no se edita ni se borra: sólo se redacta'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_message_edit_inmutable';
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE TRIGGER "TRG_message_edit_inmutable" BEFORE UPDATE OR DELETE ON "message_edit"
   FOR EACH ROW EXECUTE FUNCTION message_edit_inmutable()`,
];

export function sentenciasDeLaBandeja(): string[] {
  return [
    ...CREAR_INDICES_DE_LA_BANDEJA,
    ...CREAR_PARTES_POR_CANAL,
    ...CREAR_PERSONAS_DE_LA_EMPRESA,
    ...CREAR_MENSAJES_EDITABLES,
    ...CREAR_HISTORIAL_INMUTABLE,
  ];
}

/** Vuelve a lo de CH1: las funciones de antes y el único de la general por empresa. */
export function sentenciasParaQuitarLaBandeja(): string[] {
  return [
    `DROP TRIGGER IF EXISTS "TRG_message_edit_inmutable" ON "message_edit"`,
    `DROP FUNCTION IF EXISTS message_edit_inmutable()`,
    `DROP TRIGGER IF EXISTS "TRG_conversation_personas" ON "conversation"`,
    `DROP FUNCTION IF EXISTS conversation_personas_de_la_empresa()`,
    `DROP TRIGGER IF EXISTS "TRG_message_canal" ON "message"`,
    `DROP FUNCTION IF EXISTS message_segun_el_canal()`,
    `DROP TRIGGER IF EXISTS "TRG_message_inmutable" ON "message"`,
    `DROP FUNCTION IF EXISTS message_inmutable()`,
    `DROP TRIGGER IF EXISTS "TRG_conversation_partes" ON "conversation"`,
    `DROP FUNCTION IF EXISTS conversation_partes_validas()`,
    ...CREAR_PARTES_VALIDAS,
    ...CREAR_MENSAJES_INMUTABLES,
    ...CREAR_MENSAJES_SEGUN_EL_CANAL,
    `DROP INDEX IF EXISTS "UQ_conversation_pedido_abierta"`,
    `DROP INDEX IF EXISTS "UQ_conversation_general_abierta"`,
    `CREATE UNIQUE INDEX "UQ_conversation_general_abierta" ON "conversation" ("distributor_id", "channel") WHERE "subject_type" = 'general' AND "status" = 'open' AND "deleted_at" IS NULL`,
  ];
}
