import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Panel de plataforma (E3 del modo soporte): la bandeja de la plataforma.
 * `admin_notification.distributor_id` admite nulo (aviso del administrador
 * general, p. ej. un proceso automático atrasado o con falla) y un único
 * parcial deduplica esos avisos (el único `(distributor_id, dedupe_key)` no
 * compara nulos). El estado «en prueba» quedó para la etapa de planes
 * (`distributor_subscription`, DISENO-PLATAFORMA-ORIXTECH §14).
 */
export class PanelDePlataforma1795000000035 implements MigrationInterface {
  name = 'PanelDePlataforma1795000000035';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "admin_notification" ALTER COLUMN "distributor_id" DROP NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_admin_notification_dedupe_plataforma" ON "admin_notification" ("dedupe_key") WHERE "distributor_id" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_order_distributor_created_at_desc" ON "order" ("distributor_id", "createdAt" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_log_distributor_created_at_desc" ON "audit_log" ("distributor_id", "created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_document_reading_attempted_at" ON "document_reading" ("attempted_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_document_reading_attempted_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_audit_log_distributor_created_at_desc"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_order_distributor_created_at_desc"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_admin_notification_dedupe_plataforma"`,
    );
    // No se restaura NOT NULL: puede haber avisos de plataforma sin
    // distribuidora y un down no puede borrar datos de auditoría para lograrlo.
  }
}
