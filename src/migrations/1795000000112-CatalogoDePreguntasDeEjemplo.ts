import { MigrationInterface, QueryRunner } from 'typeorm';
import { MAPA } from './1795000000113-AuditoriaDelCatalogoDeEjemplos';

const TABLA = 'assistant_faq_template';

/**
 * El tramo del mapa de auditoría de la tabla nueva, tomado del mapa que aplica
 * la 113 (misma fuente, así no puede diferir): con él la 112 instala el
 * trigger antes de copiar y las filas copiadas quedan con su asiento de alta.
 */
export const MAPA_DEL_CATALOGO = {
  entities: MAPA.entities.filter((e) => e.table === TABLA),
  fields: MAPA.fields.filter((f) => f.table === TABLA),
};

/** Texto plano (mismo patrón que `HTML` del asistente y `CHK_assistant_faq_sin_html`). */
const sinHtml = (columna: string): string =>
  `"${columna}" !~ '<[A-Za-z/!?]' AND "${columna}" !~ '&[A-Za-z#]'`;

/** La misma pregunta: sin mayúsculas ni espacios de los bordes (como los únicos). */
const mismaPregunta = (a: string, b: string): string =>
  `lower(btrim(${a}."question")) = lower(btrim(${b}."question"))`;

/**
 * Preguntas de ejemplo para distribuidoras (DISENO-CH-BOT D-B6 y D-B7).
 *
 * Hasta acá las plantillas eran preguntas de la base de OrixTech marcadas
 * `use_as_template`. Las dos bases pasan a ser ajenas: la de OrixTech
 * contesta a las distribuidoras en el soporte y nunca se copia; las
 * plantillas son un catálogo propio.
 *
 * 1. `assistant_faq_template`: clave obligatoria (mismo formato que
 *    `CHK_assistant_faq_clave`), pregunta y respuesta con los mismos largos y
 *    texto plano que `assistant_faq`, `position` ≥ 1, baja lógica y, entre
 *    las vigentes, únicas la clave, la pregunta (sin mayúsculas ni espacios
 *    de los bordes) y la posición (el orden del catálogo).
 * 2. Las plantillas vigentes de la base de OrixTech pasan al catálogo con su
 *    clave, su texto y su orden (renumerado 1..n) y se dan de baja (lógica)
 *    de esa base, que sube su versión.
 * 3. `assistant_faq` pierde `use_as_template` y `CHK_assistant_faq_plantilla`.
 *
 * Auditoría: antes de copiar, la tabla nueva recibe su tramo del mapa con
 * `auditoria_aplicar_mapa` (el mismo camino que toda migración de auditoría,
 * ver `sql/auditoria-de-datos.ts`), así cada fila copiada deja su asiento de
 * alta escrito por `TRG_auditoria` y no uno armado a mano. La 113 vuelve a
 * aplicar el mapa completo (idempotente, mismo resultado). La baja del paso 2
 * ya queda auditada (`assistant_faq` tiene su trigger).
 *
 * Escrita a mano con los nombres que fijan las entidades: `migration:generate`
 * necesita una base.
 */
export class CatalogoDePreguntasDeEjemplo1795000000112
  implements MigrationInterface
{
  name = 'CatalogoDePreguntasDeEjemplo1795000000112';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "assistant_faq_template" ("template_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "key" character varying(60) NOT NULL, "question" character varying(200) NOT NULL, "answer" character varying(1500) NOT NULL, "position" integer NOT NULL, "updated_by" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "CHK_assistant_faq_template_clave" CHECK ("key" ~ '^[a-z0-9]+(_[a-z0-9]+)*$'), CONSTRAINT "CHK_assistant_faq_template_posicion" CHECK ("position" >= 1), CONSTRAINT "CHK_assistant_faq_template_sin_html" CHECK (${sinHtml('question')} AND ${sinHtml('answer')}), CONSTRAINT "CHK_assistant_faq_template_respuesta" CHECK (char_length(btrim("answer")) BETWEEN 1 AND 1500), CONSTRAINT "CHK_assistant_faq_template_pregunta" CHECK (char_length(btrim("question")) BETWEEN 5 AND 200), CONSTRAINT "PK_assistant_faq_template" PRIMARY KEY ("template_id"))`,
    );
    // Únicos entre las vigentes: una baja lógica libera la clave, la pregunta y la posición.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_assistant_faq_template_clave_vigente" ON "assistant_faq_template" ("key") WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_assistant_faq_template_pregunta_vigente" ON "assistant_faq_template" (lower(btrim("question"))) WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_assistant_faq_template_posicion_vigente" ON "assistant_faq_template" ("position") WHERE "deleted_at" IS NULL`,
    );

    // El trigger de auditoría antes de copiar: cada copia deja su asiento de alta.
    await queryRunner.query('SELECT auditoria_aplicar_mapa($1::jsonb)', [
      JSON.stringify(MAPA_DEL_CATALOGO),
    ]);
    // Las plantillas vigentes de OrixTech pasan al catálogo, en su orden.
    await queryRunner.query(
      `INSERT INTO "assistant_faq_template" ("key", "question", "answer", "position", "updated_by")
       SELECT "key", "question", "answer",
              row_number() OVER (ORDER BY "position", "created_at", "faq_id"), "updated_by"
         FROM "assistant_faq"
        WHERE "distributor_id" IS NULL AND "use_as_template" AND "deleted_at" IS NULL`,
    );
    // Y salen de la base de OrixTech (baja lógica), que sube su versión.
    await queryRunner.query(
      `WITH "bajas" AS (
         UPDATE "assistant_faq"
            SET "deleted_at" = now(), "updated_at" = now()
          WHERE "distributor_id" IS NULL AND "use_as_template" AND "deleted_at" IS NULL
          RETURNING "knowledge_base_id")
       UPDATE "assistant_knowledge_base"
          SET "version" = "version" + 1, "updated_at" = now()
        WHERE "knowledge_base_id" IN (SELECT "knowledge_base_id" FROM "bajas")`,
    );

    await queryRunner.query(
      `ALTER TABLE "assistant_faq" DROP CONSTRAINT "CHK_assistant_faq_plantilla"`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_faq" DROP COLUMN "use_as_template"`,
    );
  }

  /**
   * Vuelve a las plantillas dentro de la base de OrixTech: cada pregunta de
   * ejemplo vigente vuelve como una fila nueva de plantilla, con el texto del
   * catálogo, al final y en su orden, y la base sube su versión. Nunca toca
   * las preguntas propias de OrixTech (D-B6): si alguna vigente choca por
   * clave o pregunta con un ejemplo, no mezcla y falla con la lista de claves.
   * Las bajas que hizo `up` quedan como bajas (son historia auditada). El
   * catálogo se quita con su tabla.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DO $$
       DECLARE v_choques text;
       BEGIN
         SELECT string_agg(DISTINCT "t"."key", ', ' ORDER BY "t"."key") INTO v_choques
           FROM "assistant_faq_template" "t"
           JOIN "assistant_faq" "f"
             ON "f"."distributor_id" IS NULL AND "f"."deleted_at" IS NULL
            AND ("f"."key" = "t"."key" OR ${mismaPregunta('"f"', '"t"')})
          WHERE "t"."deleted_at" IS NULL;
         IF v_choques IS NOT NULL THEN
           RAISE EXCEPTION 'No se puede deshacer el catálogo de preguntas de ejemplo: la base de OrixTech tiene preguntas propias vigentes con la misma clave o la misma pregunta que estos ejemplos: %. Dalas de baja o cambiá la pregunta de ejemplo antes de deshacer la migración.', v_choques
             USING ERRCODE = 'check_violation';
         END IF;
       END $$`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_faq" ADD "use_as_template" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "assistant_faq" ADD CONSTRAINT "CHK_assistant_faq_plantilla" CHECK ("distributor_id" IS NULL OR NOT "use_as_template")`,
    );
    await queryRunner.query(
      `INSERT INTO "assistant_knowledge_base" ("distributor_id") VALUES (NULL) ON CONFLICT DO NOTHING`,
    );
    await queryRunner.query(
      `INSERT INTO "assistant_faq" ("knowledge_base_id", "distributor_id", "key", "question", "answer", "position", "use_as_template", "updated_by")
       SELECT "b"."knowledge_base_id", NULL, "t"."key", "t"."question", "t"."answer",
              (SELECT COALESCE(max("position"), 0) FROM "assistant_faq"
                WHERE "distributor_id" IS NULL AND "deleted_at" IS NULL)
              + row_number() OVER (ORDER BY "t"."position"),
              true, "t"."updated_by"
         FROM "assistant_faq_template" "t"
        CROSS JOIN "assistant_knowledge_base" "b"
        WHERE "b"."distributor_id" IS NULL AND "t"."deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "assistant_knowledge_base"
          SET "version" = "version" + 1, "updated_at" = now()
        WHERE "distributor_id" IS NULL`,
    );

    await queryRunner.query(
      `DROP INDEX "public"."UQ_assistant_faq_template_posicion_vigente"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_assistant_faq_template_pregunta_vigente"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_assistant_faq_template_clave_vigente"`,
    );
    await queryRunner.query(`DROP TABLE "assistant_faq_template"`);
  }
}
