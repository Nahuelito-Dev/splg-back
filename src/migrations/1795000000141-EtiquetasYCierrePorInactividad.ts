import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tanda 7c de la bandeja (C2/C3): etiquetas, tiempo de respuesta esperado y
 * cierre por inactividad.
 *
 * 1. `chat_label_key(text)`: la clave de un nombre sin mayúsculas ni tildes
 *    (`unaccent`, de `AsistenteDeLaEmpresa`), inmutable para poder indexarla.
 * 2. `conversation_label`: las etiquetas de cada empresa, con baja lógica,
 *    nombre único entre las vigentes de la empresa por esa clave
 *    (`UQ_conversation_label_nombre`), color de la paleta y hasta 50 vigentes
 *    (`TRG_conversation_label_tope`).
 * 3. `conversation_label_link`: las etiquetas puestas en cada conversación,
 *    de la misma empresa que la etiqueta y la conversación (FK compuestas),
 *    una vigente por par y hasta 5 vigentes por conversación, sólo etiquetas
 *    vigentes y conversaciones de la bandeja (`TRG_conversation_label_link`).
 * 4. `chat_company_settings`: `expected_reply_enabled` (prendido),
 *    `inactivity_close_minutes` y `inactivity_warning_minutes` (apagados) e
 *    `inactivity_enabled_at` (desde cuándo rigen; nulo si está apagado), con
 *    su CHECK.
 *
 * La auditoría de las tablas nuevas y de las columnas la instala la
 * siguiente (`AuditoriaDeLasEtiquetasDelChat`).
 */
export class EtiquetasYCierrePorInactividad1795000000141
  implements MigrationInterface
{
  name = 'EtiquetasYCierrePorInactividad1795000000141';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION chat_label_key(texto text) RETURNS text
         LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
         AS $$ SELECT lower(public.unaccent('public.unaccent'::regdictionary, texto)) $$`,
    );
    await queryRunner.query(
      `CREATE TABLE "conversation_label" (
        "label_id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "distributor_id" uuid NOT NULL,
        "name" character varying(30) NOT NULL,
        "color" character varying(10) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "UQ_conversation_label_id_distribuidora" UNIQUE ("label_id", "distributor_id"),
        CONSTRAINT "CHK_conversation_label_nombre" CHECK (char_length("name") BETWEEN 1 AND 30 AND "name" = btrim("name") AND "name" !~ '[\\u0001-\\u001F\\u007F-\\u009F\\u2028\\u2029]'),
        CONSTRAINT "CHK_conversation_label_color" CHECK ("color" IN ('gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink')),
        CONSTRAINT "PK_conversation_label" PRIMARY KEY ("label_id")
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_conversation_label_nombre" ON "conversation_label" ("distributor_id", chat_label_key("name")) WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_label" ADD CONSTRAINT "FK_conversation_label_distributor" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION conversation_label_tope() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW."deleted_at" IS NULL AND (TG_OP = 'INSERT' OR OLD."deleted_at" IS NOT NULL)
            AND (SELECT count(*) FROM "conversation_label"
                  WHERE "distributor_id" = NEW."distributor_id" AND "deleted_at" IS NULL
                    AND "label_id" <> NEW."label_id") >= 50 THEN
           RAISE EXCEPTION 'La empresa ya tiene 50 etiquetas vigentes'
             USING ERRCODE = '23514', CONSTRAINT = 'CHK_conversation_label_tope';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "TRG_conversation_label_tope" BEFORE INSERT OR UPDATE OF "deleted_at" ON "conversation_label" FOR EACH ROW EXECUTE FUNCTION conversation_label_tope()`,
    );

    await queryRunner.query(
      `CREATE TABLE "conversation_label_link" (
        "link_id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "conversation_id" uuid NOT NULL,
        "label_id" uuid NOT NULL,
        "distributor_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_conversation_label_link" PRIMARY KEY ("link_id")
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_conversation_label_link_vigente" ON "conversation_label_link" ("conversation_id", "label_id") WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_label_link_etiqueta" ON "conversation_label_link" ("label_id", "conversation_id") WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_label_link" ADD CONSTRAINT "FK_conversation_label_link_conversation_distribuidora" FOREIGN KEY ("conversation_id", "distributor_id") REFERENCES "conversation"("conversation_id", "distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_label_link" ADD CONSTRAINT "FK_conversation_label_link_label_distribuidora" FOREIGN KEY ("label_id", "distributor_id") REFERENCES "conversation_label"("label_id", "distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION conversation_label_link_valido() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW."deleted_at" IS NOT NULL OR (TG_OP = 'UPDATE' AND OLD."deleted_at" IS NULL) THEN
           RETURN NEW;
         END IF;
         IF NOT EXISTS (SELECT 1 FROM "conversation_label" l
                         WHERE l."label_id" = NEW."label_id" AND l."deleted_at" IS NULL)
            OR NOT EXISTS (SELECT 1 FROM "conversation" c
                            WHERE c."conversation_id" = NEW."conversation_id"
                              AND c."channel" IN ('staff_customer', 'staff_driver')) THEN
           RAISE EXCEPTION 'Sólo se ponen etiquetas vigentes en conversaciones de la bandeja'
             USING ERRCODE = '23514', CONSTRAINT = 'CHK_conversation_label_link_vigente';
         END IF;
         IF (SELECT count(*) FROM "conversation_label_link"
              WHERE "conversation_id" = NEW."conversation_id" AND "deleted_at" IS NULL
                AND "link_id" <> NEW."link_id") >= 5 THEN
           RAISE EXCEPTION 'Una conversación lleva hasta 5 etiquetas'
             USING ERRCODE = '23514', CONSTRAINT = 'CHK_conversation_label_link_tope';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "TRG_conversation_label_link" BEFORE INSERT OR UPDATE OF "deleted_at" ON "conversation_label_link" FOR EACH ROW EXECUTE FUNCTION conversation_label_link_valido()`,
    );

    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" ADD "expected_reply_enabled" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" ADD "inactivity_close_minutes" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" ADD "inactivity_warning_minutes" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" ADD "inactivity_enabled_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" ADD CONSTRAINT "CHK_chat_company_settings_inactividad" CHECK (("inactivity_close_minutes" IS NULL OR "inactivity_close_minutes" BETWEEN 30 AND 10080) AND ("inactivity_warning_minutes" IS NULL OR ("inactivity_close_minutes" IS NOT NULL AND "inactivity_warning_minutes" BETWEEN 5 AND 1440 AND "inactivity_warning_minutes" < "inactivity_close_minutes")) AND ("inactivity_close_minutes" IS NULL) = ("inactivity_enabled_at" IS NULL))`,
    );
  }

  /**
   * Sólo sin etiquetas cargadas: si las hay, frena (son datos de las
   * empresas y su historia está en la auditoría).
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const filas: unknown = await queryRunner.query(
      `SELECT count(*) AS n FROM "conversation_label"`,
    );
    const [uso] = filas as Array<{ n: string }>;
    if (Number(uso?.n ?? 0) > 0) {
      throw new Error(
        `No se puede revertir: hay ${uso.n} etiquetas de la bandeja cargadas`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" DROP CONSTRAINT "CHK_chat_company_settings_inactividad"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" DROP COLUMN "inactivity_enabled_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" DROP COLUMN "inactivity_warning_minutes"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" DROP COLUMN "inactivity_close_minutes"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" DROP COLUMN "expected_reply_enabled"`,
    );
    await queryRunner.query(`DROP TABLE "conversation_label_link"`);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS conversation_label_link_valido()`,
    );
    await queryRunner.query(`DROP TABLE "conversation_label"`);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS conversation_label_tope()`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS chat_label_key(text)`);
  }
}
