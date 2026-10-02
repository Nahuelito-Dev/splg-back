import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Las búsquedas por correo (login, guard, alta, `check-exists`) comparan
 * `LOWER(email)` para no distinguir mayúsculas: sin un índice funcional cada
 * request haría un recorrido completo de `user`. No es único: puede haber
 * correos viejos que difieran sólo en mayúsculas y una migración no decide
 * cuál se queda.
 */
export class IndiceEmailEnMinusculas1790900100000
  implements MigrationInterface
{
  name = 'IndiceEmailEnMinusculas1790900100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_email_lower" ON "user" (LOWER("email"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_email_lower"`);
  }
}
