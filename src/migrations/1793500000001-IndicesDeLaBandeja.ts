import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Índices de la bandeja del admin que faltaban:
 * - por fecha, para la campana del super admin sin «ver como» (todas las
 *   distribuidoras: el índice por distribuidora no le sirve);
 * - por usuario en las lecturas, para la FK hacia `user`.
 */
export class IndicesDeLaBandeja1793500000001 implements MigrationInterface {
  name = 'IndicesDeLaBandeja1793500000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_admin_notification_fecha" ON "admin_notification" ("created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_admin_notification_read_usuario" ON "admin_notification_read" ("user_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_admin_notification_read_usuario"`);
    await queryRunner.query(`DROP INDEX "IDX_admin_notification_fecha"`);
  }
}
