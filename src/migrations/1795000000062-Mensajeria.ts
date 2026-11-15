import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  sentenciasDeMensajeria,
  sentenciasParaQuitarMensajeria,
} from './sql/mensajeria';

/**
 * Mensajería, etapa CH1 (diseño `DISENO-COMUNICACION.md`): conversaciones,
 * partes, lectura por persona, mensajes, tickets de soporte con su enlace a
 * los mensajes citados, respuestas guardadas de la plataforma y la
 * configuración del soporte (con su fila por defecto). Los únicos parciales,
 * la secuencia de tickets y los triggers salen de `sql/mensajeria.ts`, que
 * comparten las pruebas de integración. Suma el índice de las sesiones de
 * soporte por número de ticket y el proceso `support_housekeeping` al
 * monitoreo. La auditoría de las tablas nuevas la instala
 * `AuditoriaDeLaMensajeria`.
 *
 * Escrita a mano con los nombres que fijan las entidades (todas las
 * restricciones e índices tienen nombre propio): `migration:generate` no se
 * pudo correr sin una base.
 */
export class Mensajeria1795000000062 implements MigrationInterface {
  name = 'Mensajeria1795000000062';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "conversation" ("conversation_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "channel" character varying(20) NOT NULL, "subject_type" character varying(10) NOT NULL, "status" character varying(10) NOT NULL DEFAULT 'open', "assigned_to_user_id" uuid, "subject" character varying(120), "last_message_seq" bigint NOT NULL DEFAULT '0', "last_message_at" TIMESTAMP WITH TIME ZONE, "last_message_preview" character varying(140), "first_response_at" TIMESTAMP WITH TIME ZONE, "closed_at" TIMESTAMP WITH TIME ZONE, "closed_by_user_id" uuid, "closed_reason" character varying(30), "created_by_user_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_conversation_id_distribuidora" UNIQUE ("conversation_id", "distributor_id"), CONSTRAINT "CHK_conversation_secuencia" CHECK ("last_message_seq" >= 0), CONSTRAINT "CHK_conversation_asignado" CHECK ("assigned_to_user_id" IS NULL OR "channel" = 'platform_chat'), CONSTRAINT "CHK_conversation_asunto" CHECK (("channel" = 'platform_ticket') = ("subject" IS NOT NULL) AND ("subject" IS NULL OR char_length(btrim("subject")) BETWEEN 5 AND 120)), CONSTRAINT "CHK_conversation_motivo_de_cierre" CHECK ("closed_reason" IS NULL OR "closed_reason" IN ('manual', 'inactivity', 'ticket_closed')), CONSTRAINT "CHK_conversation_cierre" CHECK (("status" = 'closed') = ("closed_at" IS NOT NULL AND "closed_reason" IS NOT NULL)), CONSTRAINT "CHK_conversation_estado" CHECK ("status" IN ('open', 'closed')), CONSTRAINT "CHK_conversation_ambito" CHECK (("channel" = 'platform_ticket') = ("subject_type" = 'ticket') AND "subject_type" IN ('general', 'ticket')), CONSTRAINT "CHK_conversation_canal" CHECK ("channel" IN ('platform_chat', 'platform_ticket')), CONSTRAINT "PK_conversation" PRIMARY KEY ("conversation_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_bandeja" ON "conversation" ("distributor_id", "channel", "status", "last_message_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_cola" ON "conversation" ("distributor_id", "assigned_to_user_id") WHERE "status" = 'open'`,
    );
    await queryRunner.query(
      `CREATE TABLE "conversation_party" ("conversation_id" uuid NOT NULL, "party" character varying(10) NOT NULL, "distributor_id" uuid NOT NULL, "user_id" uuid, "last_read_seq" bigint NOT NULL DEFAULT '0', "last_delivered_seq" bigint NOT NULL DEFAULT '0', "muted_until" TIMESTAMP WITH TIME ZONE, "restricted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "CHK_conversation_party_lecturas" CHECK ("last_read_seq" >= 0 AND "last_delivered_seq" >= 0), CONSTRAINT "CHK_conversation_party_equipo_sin_usuario" CHECK ("user_id" IS NULL), CONSTRAINT "CHK_conversation_party_parte" CHECK ("party" IN ('platform', 'company')), CONSTRAINT "PK_conversation_party" PRIMARY KEY ("conversation_id", "party"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "conversation_read_state" ("conversation_id" uuid NOT NULL, "user_id" uuid NOT NULL, "distributor_id" uuid NOT NULL, "last_read_seq" bigint NOT NULL DEFAULT '0', "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_conversation_read_state" PRIMARY KEY ("conversation_id", "user_id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "message" ("message_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "conversation_id" uuid NOT NULL, "distributor_id" uuid NOT NULL, "seq" bigint NOT NULL, "client_message_id" uuid, "sender_party" character varying(10) NOT NULL, "sender_user_id" uuid, "kind" character varying(20) NOT NULL, "visibility" character varying(10) NOT NULL DEFAULT 'all', "payload" jsonb, "body" text, "body_filtered" boolean NOT NULL DEFAULT false, "template_key" character varying(60), "system_code" character varying(60), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "redacted_at" TIMESTAMP WITH TIME ZONE, "deleted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_message_idempotencia" UNIQUE ("conversation_id", "sender_user_id", "client_message_id"), CONSTRAINT "UQ_message_conversation_seq" UNIQUE ("conversation_id", "seq"), CONSTRAINT "UQ_message_id_distribuidora" UNIQUE ("message_id", "distributor_id"), CONSTRAINT "CHK_message_payload_texto" CHECK ("kind" <> 'text' OR "payload" IS NULL), CONSTRAINT "CHK_message_cita" CHECK ("kind" <> 'quoted_excerpt' OR "redacted_at" IS NOT NULL OR (jsonb_typeof("payload" -> 'items') = 'array' AND "payload" ? 'sourceConversationId' AND "payload" ? 'fromSeq' AND "payload" ? 'toSeq')), CONSTRAINT "CHK_message_sistema" CHECK (("kind" = 'system') = ("system_code" IS NOT NULL)), CONSTRAINT "CHK_message_texto_obligatorio" CHECK ("kind" NOT IN ('text', 'auto_reply') OR "body" IS NOT NULL OR "redacted_at" IS NOT NULL), CONSTRAINT "CHK_message_texto" CHECK ("body" IS NULL OR char_length(btrim("body")) BETWEEN 1 AND 2000), CONSTRAINT "CHK_message_visibilidad" CHECK ("visibility" IN ('all', 'internal') AND ("visibility" = 'all' OR ("sender_party" = 'platform' AND "kind" = 'text'))), CONSTRAINT "CHK_message_tipo" CHECK ("kind" IN ('text', 'system', 'auto_reply', 'quoted_excerpt') AND ("kind" IN ('system', 'auto_reply')) = ("sender_party" = 'system')), CONSTRAINT "CHK_message_autor" CHECK (("sender_party" = 'system') = ("sender_user_id" IS NULL)), CONSTRAINT "CHK_message_parte" CHECK ("sender_party" IN ('platform', 'company', 'system')), CONSTRAINT "CHK_message_seq" CHECK ("seq" >= 1), CONSTRAINT "PK_message" PRIMARY KEY ("message_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_message_distribuidora_fecha" ON "message" ("distributor_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "support_ticket" ("ticket_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "conversation_id" uuid NOT NULL, "origin_conversation_id" uuid, "origin_from_seq" bigint, "origin_to_seq" bigint, "number" integer NOT NULL, "subject" character varying(120) NOT NULL, "category" character varying(20) NOT NULL, "priority" character varying(10) NOT NULL, "status" character varying(20) NOT NULL, "status_changed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "opened_by_party" character varying(10) NOT NULL, "opened_by_user_id" uuid NOT NULL, "assigned_member_user_id" uuid, "first_response_due_at" TIMESTAMP WITH TIME ZONE, "first_response_at" TIMESTAMP WITH TIME ZONE, "resolved_at" TIMESTAMP WITH TIME ZONE, "closed_at" TIMESTAMP WITH TIME ZONE, "satisfaction" smallint, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_support_ticket_number" UNIQUE ("number"), CONSTRAINT "UQ_support_ticket_conversation" UNIQUE ("conversation_id"), CONSTRAINT "UQ_support_ticket_id_distribuidora" UNIQUE ("ticket_id", "distributor_id"), CONSTRAINT "CHK_support_ticket_satisfaccion" CHECK ("satisfaction" IS NULL OR ("satisfaction" BETWEEN 1 AND 5 AND "status" IN ('resolved', 'closed'))), CONSTRAINT "CHK_support_ticket_cerrado" CHECK (("status" = 'closed') = ("closed_at" IS NOT NULL)), CONSTRAINT "CHK_support_ticket_resuelto" CHECK ("status" <> 'resolved' OR "resolved_at" IS NOT NULL), CONSTRAINT "CHK_support_ticket_numero" CHECK ("number" >= 1), CONSTRAINT "CHK_support_ticket_rango" CHECK (("origin_conversation_id" IS NULL AND "origin_from_seq" IS NULL AND "origin_to_seq" IS NULL) OR ("origin_conversation_id" IS NOT NULL AND "origin_from_seq" >= 1 AND "origin_from_seq" <= "origin_to_seq" AND "origin_to_seq" - "origin_from_seq" < 200)), CONSTRAINT "CHK_support_ticket_quien_abre" CHECK ("opened_by_party" IN ('company', 'platform')), CONSTRAINT "CHK_support_ticket_estado" CHECK ("status" IN ('new', 'open', 'waiting_company', 'resolved', 'closed')), CONSTRAINT "CHK_support_ticket_prioridad" CHECK ("priority" IN ('low', 'normal', 'high', 'urgent')), CONSTRAINT "CHK_support_ticket_categoria" CHECK ("category" IN ('billing', 'technical', 'module', 'data', 'account', 'other')), CONSTRAINT "CHK_support_ticket_asunto" CHECK (char_length(btrim("subject")) BETWEEN 5 AND 120), CONSTRAINT "PK_support_ticket" PRIMARY KEY ("ticket_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_support_ticket_cola" ON "support_ticket" ("status", "priority", "first_response_due_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_support_ticket_empresa" ON "support_ticket" ("distributor_id", "status", "updated_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_support_ticket_origen" ON "support_ticket" ("origin_conversation_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "support_ticket_message_link" ("ticket_id" uuid NOT NULL, "message_id" uuid NOT NULL, "distributor_id" uuid NOT NULL, "quoted_in_message_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by_user_id" uuid, CONSTRAINT "PK_support_ticket_message_link" PRIMARY KEY ("ticket_id", "message_id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "message_template" ("template_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid, "scope" character varying(20) NOT NULL, "key" character varying(60) NOT NULL, "title" character varying(60) NOT NULL, "body" character varying(1000) NOT NULL, "active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "CHK_message_template_texto" CHECK (char_length(btrim("body")) BETWEEN 1 AND 1000), CONSTRAINT "CHK_message_template_titulo" CHECK (char_length(btrim("title")) BETWEEN 2 AND 60), CONSTRAINT "CHK_message_template_clave" CHECK ("key" ~ '^[a-z0-9]+(_[a-z0-9]+)*$'), CONSTRAINT "CHK_message_template_alcance" CHECK ("scope" IN ('platform_reply', 'auto_reply') AND "distributor_id" IS NULL), CONSTRAINT "PK_message_template" PRIMARY KEY ("template_id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "platform_support_settings" ("settings_id" smallint NOT NULL, "timezone" character varying(60) NOT NULL DEFAULT 'America/Argentina/Buenos_Aires', "chat_hours" jsonb NOT NULL DEFAULT '[]', "chat_ack_enabled" boolean NOT NULL DEFAULT true, "chat_ack_message" character varying(500), "chat_inactivity_hours" smallint NOT NULL DEFAULT '24', "resolved_close_days" smallint NOT NULL DEFAULT '7', "waiting_close_days" smallint NOT NULL DEFAULT '7', "waiting_warn_days" smallint NOT NULL DEFAULT '5', "target_urgent_minutes" integer NOT NULL DEFAULT '60', "target_high_minutes" integer NOT NULL DEFAULT '240', "target_normal_minutes" integer NOT NULL DEFAULT '1440', "target_low_minutes" integer NOT NULL DEFAULT '4320', "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_by_user_id" uuid, CONSTRAINT "CHK_platform_support_settings_objetivos" CHECK ("target_urgent_minutes" BETWEEN 5 AND 43200 AND "target_high_minutes" BETWEEN 5 AND 43200 AND "target_normal_minutes" BETWEEN 5 AND 43200 AND "target_low_minutes" BETWEEN 5 AND 43200), CONSTRAINT "CHK_platform_support_settings_plazos" CHECK ("resolved_close_days" BETWEEN 1 AND 30 AND "waiting_close_days" BETWEEN 2 AND 30 AND "waiting_warn_days" >= 1 AND "waiting_warn_days" < "waiting_close_days"), CONSTRAINT "CHK_platform_support_settings_aviso" CHECK ("chat_ack_message" IS NULL OR char_length(btrim("chat_ack_message")) BETWEEN 1 AND 500), CONSTRAINT "CHK_platform_support_settings_inactividad" CHECK ("chat_inactivity_hours" BETWEEN 1 AND 168), CONSTRAINT "CHK_platform_support_settings_horario" CHECK (jsonb_typeof("chat_hours") = 'array'), CONSTRAINT "CHK_platform_support_settings_unica" CHECK ("settings_id" = 1), CONSTRAINT "PK_platform_support_settings" PRIMARY KEY ("settings_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_support_session_ticket" ON "support_session" ("ticket_ref") WHERE "ticket_ref" IS NOT NULL`,
    );
    for (const [tabla, fk, columnas, destino, columnasDestino, alBorrar] of [
      [
        'conversation',
        'FK_conversation_distributor',
        '"distributor_id"',
        'distributor',
        '"distributor_id"',
        'RESTRICT',
      ],
      [
        'conversation',
        'FK_conversation_assigned_to',
        '"assigned_to_user_id"',
        'user',
        '"user_id"',
        'RESTRICT',
      ],
      [
        'conversation',
        'FK_conversation_closed_by',
        '"closed_by_user_id"',
        'user',
        '"user_id"',
        'RESTRICT',
      ],
      [
        'conversation',
        'FK_conversation_created_by',
        '"created_by_user_id"',
        'user',
        '"user_id"',
        'RESTRICT',
      ],
      [
        'conversation_party',
        'FK_conversation_party_conversation_distribuidora',
        '"conversation_id", "distributor_id"',
        'conversation',
        '"conversation_id","distributor_id"',
        'NO ACTION',
      ],
      [
        'conversation_read_state',
        'FK_conversation_read_state_user',
        '"user_id"',
        'user',
        '"user_id"',
        'RESTRICT',
      ],
      [
        'conversation_read_state',
        'FK_conversation_read_state_conversation_distribuidora',
        '"conversation_id", "distributor_id"',
        'conversation',
        '"conversation_id","distributor_id"',
        'NO ACTION',
      ],
      [
        'message',
        'FK_message_sender',
        '"sender_user_id"',
        'user',
        '"user_id"',
        'RESTRICT',
      ],
      [
        'message',
        'FK_message_conversation_distribuidora',
        '"conversation_id", "distributor_id"',
        'conversation',
        '"conversation_id","distributor_id"',
        'NO ACTION',
      ],
      [
        'support_ticket',
        'FK_support_ticket_distributor',
        '"distributor_id"',
        'distributor',
        '"distributor_id"',
        'RESTRICT',
      ],
      [
        'support_ticket',
        'FK_support_ticket_opened_by',
        '"opened_by_user_id"',
        'user',
        '"user_id"',
        'RESTRICT',
      ],
      [
        'support_ticket',
        'FK_support_ticket_assigned_member',
        '"assigned_member_user_id"',
        'user',
        '"user_id"',
        'RESTRICT',
      ],
      [
        'support_ticket',
        'FK_support_ticket_conversation_distribuidora',
        '"conversation_id", "distributor_id"',
        'conversation',
        '"conversation_id","distributor_id"',
        'NO ACTION',
      ],
      [
        'support_ticket',
        'FK_support_ticket_origin_conversation_distribuidora',
        '"origin_conversation_id", "distributor_id"',
        'conversation',
        '"conversation_id","distributor_id"',
        'NO ACTION',
      ],
      [
        'support_ticket_message_link',
        'FK_support_ticket_message_link_created_by',
        '"created_by_user_id"',
        'user',
        '"user_id"',
        'RESTRICT',
      ],
      [
        'support_ticket_message_link',
        'FK_support_ticket_message_link_ticket_distribuidora',
        '"ticket_id", "distributor_id"',
        'support_ticket',
        '"ticket_id","distributor_id"',
        'NO ACTION',
      ],
      [
        'support_ticket_message_link',
        'FK_support_ticket_message_link_message_distribuidora',
        '"message_id", "distributor_id"',
        'message',
        '"message_id","distributor_id"',
        'NO ACTION',
      ],
      [
        'support_ticket_message_link',
        'FK_support_ticket_message_link_quoted_in_message_distribuidora',
        '"quoted_in_message_id", "distributor_id"',
        'message',
        '"message_id","distributor_id"',
        'NO ACTION',
      ],
      [
        'message_template',
        'FK_message_template_distributor',
        '"distributor_id"',
        'distributor',
        '"distributor_id"',
        'RESTRICT',
      ],
      [
        'platform_support_settings',
        'FK_platform_support_settings_updated_by',
        '"updated_by_user_id"',
        'user',
        '"user_id"',
        'RESTRICT',
      ],
    ] as const) {
      await queryRunner.query(
        `ALTER TABLE "${tabla}" ADD CONSTRAINT "${fk}" FOREIGN KEY (${columnas}) REFERENCES "${destino}"(${columnasDestino}) ON DELETE ${alBorrar} ON UPDATE NO ACTION`,
      );
    }
    for (const sql of sentenciasDeMensajeria()) {
      await queryRunner.query(sql);
    }
    await queryRunner.query(
      `INSERT INTO "platform_support_settings" ("settings_id") VALUES (1) ON CONFLICT DO NOTHING`,
    );
    await queryRunner.query(
      `ALTER TYPE "process_run_process_enum" ADD VALUE IF NOT EXISTS 'support_housekeeping'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // El valor `support_housekeeping` del enum de procesos queda: Postgres no
    // quita valores de un enum, y sus corridas son historia.
    for (const sql of sentenciasParaQuitarMensajeria()) {
      await queryRunner.query(sql);
    }
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_support_session_ticket"`,
    );
    for (const tabla of [
      'support_ticket_message_link',
      'support_ticket',
      'conversation_read_state',
      'conversation_party',
      'message',
      'message_template',
      'platform_support_settings',
      'conversation',
    ]) {
      await queryRunner.query(`DROP TABLE "${tabla}"`);
    }
  }
}
