import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Auditoría de datos según el modelo de la cátedra: Auditoria,
 * DetalleAuditoria y TipoAccionAuditoria. Convive con `audit_log` (bitácora
 * de requests), que no se toca. Las dos tablas nuevas son de sólo escritura,
 * como `audit_log`: un trigger rechaza todo UPDATE y DELETE. La única
 * modificación permitida es la de las claves foráneas al borrarse el usuario
 * o la distribuidora (ON DELETE SET NULL), que se reconoce porque la dispara
 * otro trigger (`pg_trigger_depth() > 1`): un UPDATE manual no pasa. El catálogo de acciones se siembra
 * con ids fijos que el código espeja en `AuditActionTypeId`.
 */
export class AuditoriaDeDatos1791161318709 implements MigrationInterface {
  name = 'AuditoriaDeDatos1791161318709';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "audit_action_type" ("action_type_id" smallint NOT NULL, "name" character varying(40) NOT NULL, CONSTRAINT "UQ_920dea5fea6e965ccf619575f55" UNIQUE ("name"), CONSTRAINT "PK_66dcf5c5aab6bba8e40c9b16e86" PRIMARY KEY ("action_type_id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "audit_detail" ("audit_detail_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "audit_id" uuid NOT NULL, "field" character varying(80) NOT NULL, "old_value" text, "new_value" text, CONSTRAINT "PK_d7889dea20a563a7248592b9860" PRIMARY KEY ("audit_detail_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_detail_audit" ON "audit_detail" ("audit_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "audit" ("audit_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "action_type_id" smallint NOT NULL, "user_id" uuid, "distributor_id" uuid, "entity" character varying(60) NOT NULL, "record_id" character varying(64) NOT NULL, "ip" character varying(45), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_75ad7632b08b4cfadec337a7c8d" PRIMARY KEY ("audit_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_user" ON "audit" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_distributor_created_at" ON "audit" ("distributor_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_entity_record" ON "audit" ("entity", "record_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_detail" ADD CONSTRAINT "FK_1836695bfd4e04a29b66022fff1" FOREIGN KEY ("audit_id") REFERENCES "audit"("audit_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit" ADD CONSTRAINT "FK_9ffdecf0e48efaf0ae09b844d43" FOREIGN KEY ("action_type_id") REFERENCES "audit_action_type"("action_type_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit" ADD CONSTRAINT "FK_c0cfc23f3e46b9aaf5a40254330" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit" ADD CONSTRAINT "FK_d214d146099cc53049201a1efd5" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `INSERT INTO "audit_action_type" ("action_type_id", "name") VALUES (1, 'Alta'), (2, 'Modificación'), (3, 'Baja lógica'), (4, 'Reactivación'), (5, 'Baja física')`,
    );
    await queryRunner.query(`
            CREATE FUNCTION audit_datos_inmutable() RETURNS trigger AS $$
            BEGIN
              IF TG_TABLE_NAME = 'audit' AND TG_OP = 'UPDATE' AND pg_trigger_depth() > 1 THEN
                IF (NEW.user_id IS NULL OR NEW.user_id = OLD.user_id)
                   AND (NEW.distributor_id IS NULL OR NEW.distributor_id = OLD.distributor_id)
                   AND (to_jsonb(NEW) - 'user_id' - 'distributor_id')
                     = (to_jsonb(OLD) - 'user_id' - 'distributor_id') THEN
                  RETURN NEW;
                END IF;
              END IF;
              RAISE EXCEPTION '% es de sólo escritura: no se modifican ni se borran auditorías', TG_TABLE_NAME;
            END;
            $$ LANGUAGE plpgsql
        `);
    await queryRunner.query(
      `CREATE TRIGGER audit_inmutable BEFORE UPDATE OR DELETE ON "audit" FOR EACH ROW EXECUTE FUNCTION audit_datos_inmutable()`,
    );
    await queryRunner.query(
      `CREATE TRIGGER audit_detail_inmutable BEFORE UPDATE OR DELETE ON "audit_detail" FOR EACH ROW EXECUTE FUNCTION audit_datos_inmutable()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS audit_detail_inmutable ON "audit_detail"`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS audit_inmutable ON "audit"`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS audit_datos_inmutable()`);
    await queryRunner.query(
      `ALTER TABLE "audit" DROP CONSTRAINT "FK_d214d146099cc53049201a1efd5"`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit" DROP CONSTRAINT "FK_c0cfc23f3e46b9aaf5a40254330"`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit" DROP CONSTRAINT "FK_9ffdecf0e48efaf0ae09b844d43"`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_detail" DROP CONSTRAINT "FK_1836695bfd4e04a29b66022fff1"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_audit_entity_record"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_audit_distributor_created_at"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_audit_user"`);
    await queryRunner.query(`DROP TABLE "audit"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_audit_detail_audit"`);
    await queryRunner.query(`DROP TABLE "audit_detail"`);
    await queryRunner.query(`DROP TABLE "audit_action_type"`);
  }
}
