import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tanda 8b de la bandeja (C2/C3): asignación automática.
 *
 * 1. `chat_company_settings`: `auto_assign_enabled` (apagada) y
 *    `auto_assign_max_open` (5), con su CHECK (1 a 50).
 * 2. `admin`: único `(user_id, distributor_id)` (`user_id` ya es único; sirve
 *    de destino a la clave compuesta del punto 3).
 * 3. `chat_agent_settings`: una fila por empresa y persona del equipo, con su
 *    estado (`online`/`away`), desde cuándo, su tope propio (nulo: el de la
 *    empresa) y cuándo recibió la última. La persona tiene que ser del
 *    personal de esa empresa (`FK_chat_agent_settings_user_distribuidora`).
 * 4. `conversation`: `assigned_automatically` (la tomó la asignación
 *    automática), que sólo puede estar prendida con alguien asignado en la
 *    bandeja; «esperando persona» ahora también en las de los choferes; y el
 *    índice de la cola (las que esperan sin asignar, la más vieja primero).
 *
 * La auditoría de la tabla y las columnas nuevas la instala la siguiente
 * (`AuditoriaDeLaAsignacionAutomatica`).
 */
export class AsignacionAutomaticaDelChat1795000000144
  implements MigrationInterface
{
  name = 'AsignacionAutomaticaDelChat1795000000144';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" ADD "auto_assign_enabled" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" ADD "auto_assign_max_open" smallint NOT NULL DEFAULT 5`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" ADD CONSTRAINT "CHK_chat_company_settings_asignacion" CHECK ("auto_assign_max_open" BETWEEN 1 AND 50)`,
    );

    await queryRunner.query(
      `ALTER TABLE "admin" ADD CONSTRAINT "UQ_admin_id_distribuidora" UNIQUE ("user_id", "distributor_id")`,
    );

    await queryRunner.query(
      `CREATE TABLE "chat_agent_settings" (
        "distributor_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "status" character varying(10) NOT NULL DEFAULT 'away',
        "status_changed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "max_open_override" smallint,
        "last_assigned_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_chat_agent_settings_estado" CHECK ("status" IN ('online', 'away')),
        CONSTRAINT "CHK_chat_agent_settings_tope" CHECK ("max_open_override" IS NULL OR "max_open_override" BETWEEN 1 AND 50),
        CONSTRAINT "PK_chat_agent_settings" PRIMARY KEY ("distributor_id", "user_id")
      )`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_agent_settings" ADD CONSTRAINT "FK_chat_agent_settings_distributor" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_agent_settings" ADD CONSTRAINT "FK_chat_agent_settings_user" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_agent_settings" ADD CONSTRAINT "FK_chat_agent_settings_user_distribuidora" FOREIGN KEY ("user_id", "distributor_id") REFERENCES "admin"("user_id", "distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `ALTER TABLE "conversation" ADD "assigned_automatically" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" ADD CONSTRAINT "CHK_conversation_asignada_sola" CHECK (NOT "assigned_automatically" OR ("assigned_to_user_id" IS NOT NULL AND "channel" IN ('staff_customer', 'staff_driver')))`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP CONSTRAINT "CHK_conversation_esperando_persona"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" ADD CONSTRAINT "CHK_conversation_esperando_persona" CHECK ("awaiting_human_since" IS NULL OR "channel" IN ('platform_chat', 'staff_customer', 'staff_driver'))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_conversation_esperando" ON "conversation" ("distributor_id", "awaiting_human_since") WHERE "status" = 'open' AND "assigned_to_user_id" IS NULL AND "awaiting_human_since" IS NOT NULL`,
    );
  }

  /**
   * Sólo si ninguna conversación de choferes quedó esperando a una persona
   * (el CHECK anterior no la admitiría); el estado de cada persona se pierde.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const filas: unknown = await queryRunner.query(
      `SELECT count(*) AS n FROM "conversation" WHERE "channel" = 'staff_driver' AND "awaiting_human_since" IS NOT NULL`,
    );
    const [uso] = filas as Array<{ n: string }>;
    if (Number(uso?.n ?? 0) > 0) {
      throw new Error(
        `No se puede revertir: hay ${uso.n} conversaciones con choferes esperando a una persona`,
      );
    }
    await queryRunner.query(`DROP INDEX "IDX_conversation_esperando"`);
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP CONSTRAINT "CHK_conversation_esperando_persona"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" ADD CONSTRAINT "CHK_conversation_esperando_persona" CHECK ("awaiting_human_since" IS NULL OR "channel" IN ('platform_chat', 'staff_customer'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP CONSTRAINT "CHK_conversation_asignada_sola"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation" DROP COLUMN "assigned_automatically"`,
    );
    await queryRunner.query(`DROP TABLE "chat_agent_settings"`);
    await queryRunner.query(
      `ALTER TABLE "admin" DROP CONSTRAINT "UQ_admin_id_distribuidora"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" DROP CONSTRAINT "CHK_chat_company_settings_asignacion"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" DROP COLUMN "auto_assign_max_open"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" DROP COLUMN "auto_assign_enabled"`,
    );
  }
}
