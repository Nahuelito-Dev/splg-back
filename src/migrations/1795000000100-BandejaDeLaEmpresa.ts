import { MigrationInterface, QueryRunner } from 'typeorm';
import { checkModuloConocido } from '../platform/modules/catalogo-de-modulos';
import {
  sentenciasDeLaBandeja,
  sentenciasParaQuitarLaBandeja,
} from './sql/bandeja-de-la-empresa';

/** Los módulos del catálogo antes de esta migración (para volver atrás). */
const MODULOS_ANTERIORES = [
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

const checkAnterior = (columna: string): string =>
  `"${columna}" IN (${MODULOS_ANTERIORES.map((m) => `'${m}'`).join(', ')})`;

/** CHECK que cambian (TypeORM no detecta un CHECK con el mismo nombre y otra expresión). */
export const CHECKS_DE_LA_BANDEJA: ReadonlyArray<
  readonly [tabla: string, nombre: string, nueva: string, anterior: string]
> = [
  [
    'conversation',
    'CHK_conversation_canal',
    `"channel" IN ('platform_chat', 'platform_ticket', 'staff_customer', 'staff_driver')`,
    `"channel" IN ('platform_chat', 'platform_ticket')`,
  ],
  [
    'conversation',
    'CHK_conversation_ambito',
    `("channel" = 'platform_ticket') = ("subject_type" = 'ticket') AND "subject_type" IN ('general', 'ticket', 'order') AND ("subject_type" <> 'order' OR "channel" IN ('staff_customer', 'staff_driver'))`,
    `("channel" = 'platform_ticket') = ("subject_type" = 'ticket') AND "subject_type" IN ('general', 'ticket')`,
  ],
  [
    'conversation',
    'CHK_conversation_asignado',
    `"assigned_to_user_id" IS NULL OR "channel" IN ('platform_chat', 'staff_customer', 'staff_driver')`,
    `"assigned_to_user_id" IS NULL OR "channel" = 'platform_chat'`,
  ],
  [
    'conversation_party',
    'CHK_conversation_party_parte',
    `"party" IN ('platform', 'company', 'customer', 'driver')`,
    `"party" IN ('platform', 'company')`,
  ],
  [
    'conversation_party',
    'CHK_conversation_party_equipo_sin_usuario',
    `("party" IN ('platform', 'company')) = ("user_id" IS NULL)`,
    `"user_id" IS NULL`,
  ],
  [
    'message',
    'CHK_message_parte',
    `"sender_party" IN ('platform', 'company', 'customer', 'driver', 'system')`,
    `"sender_party" IN ('platform', 'company', 'system')`,
  ],
  [
    'message_template',
    'CHK_message_template_alcance',
    `("scope" IN ('platform_reply', 'auto_reply') AND "distributor_id" IS NULL AND "channel" IS NULL) OR ("scope" = 'staff_reply' AND "distributor_id" IS NOT NULL)`,
    `"scope" IN ('platform_reply', 'auto_reply') AND "distributor_id" IS NULL`,
  ],
  [
    'distributor_module',
    'CHK_distributor_module_clave',
    checkModuloConocido('module_key'),
    checkAnterior('module_key'),
  ],
  [
    'platform_plan_module',
    'CHK_platform_plan_module_clave',
    checkModuloConocido('module_key'),
    checkAnterior('module_key'),
  ],
];

/** Planes que traen `chat` (D-C16: Completo y Prueba; Básico no). */
const PLANES_CON_CHAT = ['trial', 'full'];

/**
 * Mensajería, etapa CH3 (diseño `DISENO-COMUNICACION.md` §11 CH3): la bandeja
 * de la empresa con sus clientes (C3, `staff_customer`) y sus choferes (C2,
 * `staff_driver`) sobre el núcleo de CH1.
 *
 *  - `conversation`: pedido (FK compuesta con la empresa), cliente, chofer y
 *    reclamo vinculado (FK compuesta: `claims` suma su único
 *    `(claim_id, distributor_id)`); los CHECK de canal, ámbito y asignación
 *    se amplían.
 *  - `conversation_party`: las partes de una persona (`customer`, `driver`)
 *    llevan su usuario.
 *  - `message`: responde a otro mensaje de la misma conversación
 *    (`reply_to_seq`, FK compuesta contra `(conversation_id, seq)`) y la
 *    marca de edición (`edited_at`); `message_edit` guarda el texto anterior.
 *  - `message_template`: respuestas guardadas de cada empresa
 *    (`staff_reply`, con canal opcional).
 *  - `chat_company_settings`: horario de atención y respuestas automáticas.
 *  - Módulo `chat` en el catálogo (CHECK de `distributor_module` y
 *    `platform_plan_module`), en los planes Completo y Prueba y en la foto de
 *    las suscripciones vigentes de esos planes (D-C16).
 *
 * Lo que TypeORM no modela (únicos parciales, triggers) sale de
 * `sql/bandeja-de-la-empresa.ts`. El SQL de las tablas y columnas es el que
 * genera `migration:generate` (revisado a mano); los CHECK que cambian de
 * expresión van aparte (TypeORM no los detecta). La auditoría de las tablas y
 * columnas nuevas la instala `AuditoriaDeLaBandejaDeLaEmpresa`.
 */
export class BandejaDeLaEmpresa1795000000100 implements MigrationInterface {
  name = 'BandejaDeLaEmpresa1795000000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "message_edit" ("edit_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "message_id" uuid NOT NULL, "distributor_id" uuid NOT NULL, "previous_body" text, "edited_by_user_id" uuid NOT NULL, "edited_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_message_edit_texto" CHECK ("previous_body" IS NULL OR char_length(btrim("previous_body")) BETWEEN 1 AND 2000), CONSTRAINT "PK_message_edit" PRIMARY KEY ("edit_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_message_edit_mensaje" ON "message_edit" ("message_id", "edited_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "chat_company_settings" ("distributor_id" uuid NOT NULL, "timezone" character varying(60) NOT NULL DEFAULT 'America/Argentina/Buenos_Aires', "business_hours" jsonb NOT NULL DEFAULT '[]', "holidays" jsonb NOT NULL DEFAULT '[]', "customer_chat_enabled" boolean NOT NULL DEFAULT true, "out_of_hours_enabled" boolean NOT NULL DEFAULT true, "out_of_hours_message" character varying(500), "ack_enabled" boolean NOT NULL DEFAULT false, "ack_message" character varying(500), "first_response_target_minutes" smallint NOT NULL DEFAULT '30', "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_by_user_id" uuid, CONSTRAINT "CHK_chat_company_settings_objetivo" CHECK ("first_response_target_minutes" BETWEEN 5 AND 1440), CONSTRAINT "CHK_chat_company_settings_textos" CHECK (("out_of_hours_message" IS NULL OR char_length(btrim("out_of_hours_message")) BETWEEN 1 AND 500) AND ("ack_message" IS NULL OR char_length(btrim("ack_message")) BETWEEN 1 AND 500)), CONSTRAINT "CHK_chat_company_settings_horario" CHECK (jsonb_typeof("business_hours") = 'array' AND jsonb_typeof("holidays") = 'array'), CONSTRAINT "PK_chat_company_settings" PRIMARY KEY ("distributor_id"))`,
    );
    await queryRunner.query(`ALTER TABLE "conversation" ADD "order_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "conversation" ADD "customer_user_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" ADD "driver_user_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" ADD "linked_claim_id" uuid`,
    );
    await queryRunner.query(`ALTER TABLE "message" ADD "reply_to_seq" bigint`);
    await queryRunner.query(
      `ALTER TABLE "message" ADD "edited_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "message_template" ADD "channel" character varying(20)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_del_chofer" ON "conversation" ("driver_user_id", "distributor_id", "last_message_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_del_cliente" ON "conversation" ("customer_user_id", "distributor_id", "last_message_at") `,
    );
    for (const [tabla, nombre, nueva] of CHECKS_DE_LA_BANDEJA) {
      await queryRunner.query(
        `ALTER TABLE "${tabla}" DROP CONSTRAINT "${nombre}"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${tabla}" ADD CONSTRAINT "${nombre}" CHECK (${nueva})`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE "conversation" ADD CONSTRAINT "CHK_conversation_reclamo" CHECK ("linked_claim_id" IS NULL OR "channel" = 'staff_customer')`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" ADD CONSTRAINT "CHK_conversation_personas" CHECK (("channel" = 'staff_customer') = ("customer_user_id" IS NOT NULL) AND ("channel" = 'staff_driver') = ("driver_user_id" IS NOT NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" ADD CONSTRAINT "CHK_conversation_pedido" CHECK (("subject_type" = 'order') = ("order_id" IS NOT NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "message" ADD CONSTRAINT "CHK_message_editado" CHECK ("edited_at" IS NULL OR ("kind" = 'text' AND "sender_user_id" IS NOT NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "message" ADD CONSTRAINT "CHK_message_respuesta" CHECK ("reply_to_seq" IS NULL OR ("reply_to_seq" >= 1 AND "reply_to_seq" < "seq"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "message_template" ADD CONSTRAINT "CHK_message_template_canal" CHECK ("channel" IS NULL OR "channel" IN ('staff_customer', 'staff_driver'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "claims" ADD CONSTRAINT "UQ_claims_id_distribuidora" UNIQUE ("claim_id", "distributor_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" ADD CONSTRAINT "FK_conversation_customer" FOREIGN KEY ("customer_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" ADD CONSTRAINT "FK_conversation_driver" FOREIGN KEY ("driver_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" ADD CONSTRAINT "FK_conversation_linked_claim_distribuidora" FOREIGN KEY ("linked_claim_id", "distributor_id") REFERENCES "claims"("claim_id","distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" ADD CONSTRAINT "FK_conversation_order_distribuidora" FOREIGN KEY ("order_id", "distributor_id") REFERENCES "order"("order_id","distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "message" ADD CONSTRAINT "FK_message_respuesta" FOREIGN KEY ("conversation_id", "reply_to_seq") REFERENCES "message"("conversation_id","seq") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "message_edit" ADD CONSTRAINT "FK_message_edit_edited_by" FOREIGN KEY ("edited_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "message_edit" ADD CONSTRAINT "FK_message_edit_message_distribuidora" FOREIGN KEY ("message_id", "distributor_id") REFERENCES "message"("message_id","distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" ADD CONSTRAINT "FK_chat_company_settings_distributor" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" ADD CONSTRAINT "FK_chat_company_settings_updated_by" FOREIGN KEY ("updated_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    for (const sentencia of sentenciasDeLaBandeja()) {
      await queryRunner.query(sentencia);
    }
    // D-C16: Completo y Prueba traen `chat`, también las suscripciones
    // vigentes de esos planes (la foto suma el módulo; el resto queda igual).
    for (const plan of PLANES_CON_CHAT) {
      await queryRunner.query(
        `INSERT INTO "platform_plan_module" ("plan_code", "module_key") VALUES ($1, 'chat') ON CONFLICT DO NOTHING`,
        [plan],
      );
    }
    await queryRunner.query(
      `UPDATE "distributor_subscription"
          SET "plan_snapshot" = jsonb_set("plan_snapshot", '{modules}', ("plan_snapshot" -> 'modules') || '["chat"]'::jsonb)
        WHERE "plan_code" = ANY($1::text[])
          AND jsonb_typeof("plan_snapshot" -> 'modules') = 'array'
          AND NOT ("plan_snapshot" -> 'modules') ? 'chat'`,
      [PLANES_CON_CHAT],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "distributor_subscription"
          SET "plan_snapshot" = jsonb_set("plan_snapshot", '{modules}', ("plan_snapshot" -> 'modules') - 'chat')
        WHERE ("plan_snapshot" -> 'modules') ? 'chat'`,
    );
    await queryRunner.query(
      `DELETE FROM "platform_plan_module" WHERE "module_key" = 'chat'`,
    );
    for (const sentencia of sentenciasParaQuitarLaBandeja()) {
      await queryRunner.query(sentencia);
    }
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" DROP CONSTRAINT "FK_chat_company_settings_updated_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" DROP CONSTRAINT "FK_chat_company_settings_distributor"`,
    );
    await queryRunner.query(
      `ALTER TABLE "message_edit" DROP CONSTRAINT "FK_message_edit_message_distribuidora"`,
    );
    await queryRunner.query(
      `ALTER TABLE "message_edit" DROP CONSTRAINT "FK_message_edit_edited_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "message" DROP CONSTRAINT "FK_message_respuesta"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP CONSTRAINT "FK_conversation_order_distribuidora"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP CONSTRAINT "FK_conversation_linked_claim_distribuidora"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP CONSTRAINT "FK_conversation_driver"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP CONSTRAINT "FK_conversation_customer"`,
    );
    await queryRunner.query(
      `ALTER TABLE "claims" DROP CONSTRAINT "UQ_claims_id_distribuidora"`,
    );
    await queryRunner.query(
      `ALTER TABLE "message_template" DROP CONSTRAINT "CHK_message_template_canal"`,
    );
    await queryRunner.query(
      `ALTER TABLE "message" DROP CONSTRAINT "CHK_message_respuesta"`,
    );
    await queryRunner.query(
      `ALTER TABLE "message" DROP CONSTRAINT "CHK_message_editado"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP CONSTRAINT "CHK_conversation_pedido"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP CONSTRAINT "CHK_conversation_personas"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP CONSTRAINT "CHK_conversation_reclamo"`,
    );
    // Volver a los CHECK de antes exige que no queden conversaciones de la
    // bandeja ni excepciones del módulo `chat`: el `down` falla si ya se usó
    // (no se borran datos para poder bajar).
    for (const [tabla, nombre, , anterior] of [
      ...CHECKS_DE_LA_BANDEJA,
    ].reverse()) {
      await queryRunner.query(
        `ALTER TABLE "${tabla}" DROP CONSTRAINT "${nombre}"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${tabla}" ADD CONSTRAINT "${nombre}" CHECK (${anterior})`,
      );
    }
    await queryRunner.query(
      `DROP INDEX "public"."IDX_conversation_del_cliente"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_conversation_del_chofer"`,
    );
    await queryRunner.query(
      `ALTER TABLE "message_template" DROP COLUMN "channel"`,
    );
    await queryRunner.query(`ALTER TABLE "message" DROP COLUMN "edited_at"`);
    await queryRunner.query(`ALTER TABLE "message" DROP COLUMN "reply_to_seq"`);
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP COLUMN "linked_claim_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP COLUMN "driver_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP COLUMN "customer_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP COLUMN "order_id"`,
    );
    await queryRunner.query(`DROP TABLE "chat_company_settings"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_message_edit_mensaje"`);
    await queryRunner.query(`DROP TABLE "message_edit"`);
  }
}
