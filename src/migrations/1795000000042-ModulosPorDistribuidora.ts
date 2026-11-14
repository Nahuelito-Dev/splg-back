import { MigrationInterface, QueryRunner } from 'typeorm';

/** Módulos de cada plan sembrado (D-P1), fijos: la migración no lee el catálogo vivo. */
const TODOS = [
  'document_reading',
  'route_planning',
  'route_batching',
  'repurchase',
  'cylinder_recovery',
  'fleet_planner',
  'whatsapp',
  'mercadopago',
  'express',
];
const MODULOS_POR_PLAN: Record<string, string[]> = {
  trial: TODOS,
  basic: ['mercadopago', 'express'],
  full: TODOS,
};

/**
 * Módulos por distribuidora (DISENO-PLATAFORMA-ORIXTECH §4.2–§4.3, etapa P1):
 *
 *  - `platform_plan` y `platform_plan_module` con los tres planes sembrados
 *    (D-P1): Prueba (todo, topes chicos), Básico (núcleo + Mercado Pago +
 *    compra express) y Completo (todo).
 *  - `distributor_subscription` mínima: plan, foto del plan, estado e
 *    `is_internal`. Todas las empresas existentes entran al plan `full`
 *    activas (no se apaga nada); la propia de la plataforma, con
 *    `is_internal = true`.
 *  - `distributor_module`: las excepciones de la plataforma sobre el plan.
 *  - Trigger `TRG_distributor_suscripcion_inicial`: toda distribuidora nueva
 *    nace con su suscripción `full` activa, la cree quien la cree (alta del
 *    panel, siembras, scripts). La relación 1:1 la garantiza la base.
 *
 * Los precios son de demostración (valores redondos, D-P1).
 */
export class ModulosPorDistribuidora1795000000042
  implements MigrationInterface
{
  name = 'ModulosPorDistribuidora1795000000042';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."subscription_status" AS ENUM('trial', 'active', 'past_due', 'restricted', 'suspended', 'cancelled')`,
    );
    await queryRunner.query(
      `CREATE TABLE "platform_plan" ("plan_code" character varying(30) NOT NULL, "name" character varying(60) NOT NULL, "monthly_price" numeric(14,2) NOT NULL, "currency" character(3) NOT NULL, "trial_days" smallint, "limits" jsonb NOT NULL, "is_public" boolean NOT NULL DEFAULT true, "version" integer NOT NULL DEFAULT '1', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "CHK_platform_plan_limites" CHECK (COALESCE(jsonb_typeof("limits") = 'object' AND "limits" ?& ARRAY['maxDrivers', 'maxAdmins', 'maxOrdersMonth', 'documentReadingUsdMonth'] AND ("limits" - ARRAY['maxDrivers', 'maxAdmins', 'maxOrdersMonth', 'documentReadingUsdMonth']) = '{}'::jsonb AND (jsonb_typeof("limits" -> 'maxDrivers') = 'null' OR (jsonb_typeof("limits" -> 'maxDrivers') = 'number' AND ("limits" ->> 'maxDrivers')::numeric >= 0)) AND (jsonb_typeof("limits" -> 'maxAdmins') = 'null' OR (jsonb_typeof("limits" -> 'maxAdmins') = 'number' AND ("limits" ->> 'maxAdmins')::numeric >= 0)) AND (jsonb_typeof("limits" -> 'maxOrdersMonth') = 'null' OR (jsonb_typeof("limits" -> 'maxOrdersMonth') = 'number' AND ("limits" ->> 'maxOrdersMonth')::numeric >= 0)) AND (jsonb_typeof("limits" -> 'documentReadingUsdMonth') = 'null' OR (jsonb_typeof("limits" -> 'documentReadingUsdMonth') = 'number' AND ("limits" ->> 'documentReadingUsdMonth')::numeric >= 0)), false)), CONSTRAINT "CHK_platform_plan_version" CHECK ("version" >= 1), CONSTRAINT "CHK_platform_plan_prueba" CHECK (("plan_code" = 'trial') = ("trial_days" IS NOT NULL) AND ("trial_days" IS NULL OR "trial_days" BETWEEN 1 AND 365)), CONSTRAINT "CHK_platform_plan_moneda" CHECK ("currency" ~ '^[A-Z]{3}$'), CONSTRAINT "CHK_platform_plan_precio" CHECK ("monthly_price" >= 0), CONSTRAINT "CHK_platform_plan_nombre" CHECK (btrim("name") <> ''), CONSTRAINT "CHK_platform_plan_codigo" CHECK ("plan_code" ~ '^[a-z][a-z0-9_]{1,29}$'), CONSTRAINT "PK_platform_plan" PRIMARY KEY ("plan_code"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "platform_plan_module" ("plan_code" character varying(30) NOT NULL, "module_key" character varying(40) NOT NULL, CONSTRAINT "CHK_platform_plan_module_clave" CHECK ("module_key" IN ('document_reading', 'route_planning', 'route_batching', 'repurchase', 'cylinder_recovery', 'fleet_planner', 'whatsapp', 'mercadopago', 'express')), CONSTRAINT "PK_platform_plan_module" PRIMARY KEY ("plan_code", "module_key"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "distributor_subscription" ("distributor_id" uuid NOT NULL, "plan_code" character varying(30) NOT NULL, "plan_snapshot" jsonb NOT NULL, "status" "public"."subscription_status" NOT NULL DEFAULT 'active', "is_internal" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_distributor_subscription_foto" CHECK (COALESCE(jsonb_typeof("plan_snapshot") = 'object' AND "plan_snapshot" ?& ARRAY['modules', 'limits'] AND jsonb_typeof("plan_snapshot" -> 'modules') = 'array' AND jsonb_typeof("plan_snapshot" -> 'limits') = 'object', false)), CONSTRAINT "PK_distributor_subscription" PRIMARY KEY ("distributor_id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "distributor_module" ("distributor_id" uuid NOT NULL, "module_key" character varying(40) NOT NULL, "enabled" boolean, "reason" character varying(300) NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE, "updated_by" uuid NOT NULL, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_distributor_module_vencimiento" CHECK ("enabled" IS NOT NULL OR "expires_at" IS NULL), CONSTRAINT "CHK_distributor_module_motivo" CHECK (char_length(btrim("reason")) BETWEEN 10 AND 300), CONSTRAINT "CHK_distributor_module_clave" CHECK ("module_key" IN ('document_reading', 'route_planning', 'route_batching', 'repurchase', 'cylinder_recovery', 'fleet_planner', 'whatsapp', 'mercadopago', 'express')), CONSTRAINT "PK_distributor_module" PRIMARY KEY ("distributor_id", "module_key"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_plan_module" ADD CONSTRAINT "FK_platform_plan_module_plan" FOREIGN KEY ("plan_code") REFERENCES "platform_plan"("plan_code") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor_subscription" ADD CONSTRAINT "FK_distributor_subscription_distributor" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor_subscription" ADD CONSTRAINT "FK_distributor_subscription_plan" FOREIGN KEY ("plan_code") REFERENCES "platform_plan"("plan_code") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor_module" ADD CONSTRAINT "FK_distributor_module_distributor" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor_module" ADD CONSTRAINT "FK_distributor_module_updated_by" FOREIGN KEY ("updated_by") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );

    // Los tres planes (D-P1). Topes `null` = sin tope.
    const planes: Array<[string, string, string, number | null, object]> = [
      [
        'trial',
        'Prueba',
        '0.00',
        30,
        {
          maxDrivers: 3,
          maxAdmins: 2,
          maxOrdersMonth: 300,
          documentReadingUsdMonth: 5,
        },
      ],
      [
        'basic',
        'Básico',
        '15000.00',
        null,
        {
          maxDrivers: 10,
          maxAdmins: 3,
          maxOrdersMonth: null,
          documentReadingUsdMonth: 0,
        },
      ],
      [
        'full',
        'Completo',
        '35000.00',
        null,
        {
          maxDrivers: null,
          maxAdmins: null,
          maxOrdersMonth: null,
          documentReadingUsdMonth: null,
        },
      ],
    ];
    for (const [code, nombre, precio, dias, topes] of planes) {
      await queryRunner.query(
        `INSERT INTO "platform_plan" ("plan_code", "name", "monthly_price", "currency", "trial_days", "limits", "is_public") VALUES ($1, $2, $3, 'ARS', $4, $5::jsonb, true)`,
        [code, nombre, precio, dias, JSON.stringify(topes)],
      );
      for (const modulo of MODULOS_POR_PLAN[code]) {
        await queryRunner.query(
          `INSERT INTO "platform_plan_module" ("plan_code", "module_key") VALUES ($1, $2)`,
          [code, modulo],
        );
      }
    }

    // La foto de un plan, tal como queda en la suscripción.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION plataforma_foto_del_plan(p_plan varchar)
      RETURNS jsonb LANGUAGE sql STABLE AS $$
        SELECT jsonb_build_object(
          'modules', COALESCE((SELECT jsonb_agg(m."module_key" ORDER BY m."module_key")
                               FROM "platform_plan_module" m WHERE m."plan_code" = p."plan_code"), '[]'::jsonb),
          'limits', p."limits",
          'monthlyPrice', p."monthly_price"::text,
          'currency', p."currency",
          'version', p."version")
        FROM "platform_plan" p WHERE p."plan_code" = p_plan
      $$`);

    // Las empresas existentes (también las dadas de baja: la relación es 1:1).
    await queryRunner.query(
      `INSERT INTO "distributor_subscription" ("distributor_id", "plan_code", "plan_snapshot", "status", "is_internal")
       SELECT d."distributor_id", 'full', plataforma_foto_del_plan('full'), 'active', d."owned_by_platform"
       FROM "distributor" d`,
    );

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION plataforma_suscripcion_inicial()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO "distributor_subscription" ("distributor_id", "plan_code", "plan_snapshot", "status", "is_internal")
        VALUES (NEW."distributor_id", 'full', plataforma_foto_del_plan('full'), 'active', NEW."owned_by_platform")
        ON CONFLICT ("distributor_id") DO NOTHING;
        RETURN NEW;
      END
      $$`);
    await queryRunner.query(
      `CREATE TRIGGER "TRG_distributor_suscripcion_inicial" AFTER INSERT ON "distributor" FOR EACH ROW EXECUTE FUNCTION plataforma_suscripcion_inicial()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "TRG_distributor_suscripcion_inicial" ON "distributor"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS plataforma_suscripcion_inicial()`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS plataforma_foto_del_plan(varchar)`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor_module" DROP CONSTRAINT "FK_distributor_module_updated_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor_module" DROP CONSTRAINT "FK_distributor_module_distributor"`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor_subscription" DROP CONSTRAINT "FK_distributor_subscription_plan"`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor_subscription" DROP CONSTRAINT "FK_distributor_subscription_distributor"`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_plan_module" DROP CONSTRAINT "FK_platform_plan_module_plan"`,
    );
    await queryRunner.query(`DROP TABLE "distributor_module"`);
    await queryRunner.query(`DROP TABLE "distributor_subscription"`);
    await queryRunner.query(`DROP TABLE "platform_plan_module"`);
    await queryRunner.query(`DROP TABLE "platform_plan"`);
    await queryRunner.query(`DROP TYPE "public"."subscription_status"`);
  }
}
