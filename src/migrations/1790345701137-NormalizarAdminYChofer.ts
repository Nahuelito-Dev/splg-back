import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Normalización: admin.role_id repetía user.role_id (dependencia transitiva
 * admin → user → role) y permitía que los dos dijeran cosas distintas (H-77);
 * se quita y el perfil queda único por usuario. delivery.isTraveling no lo
 * escribía nadie (0 filas con valor) y es derivable de los pedidos en camino.
 */
export class NormalizarAdminYChofer1790345701137 implements MigrationInterface {
  name = 'NormalizarAdminYChofer1790345701137';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "admin" DROP CONSTRAINT "FK_fd32421f2d93414e46a8fcfd86b"`,
    );
    await queryRunner.query(`ALTER TABLE "delivery" DROP COLUMN "isTraveling"`);
    await queryRunner.query(`ALTER TABLE "admin" DROP COLUMN "role_id"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_admin_user" ON "admin" ("user_id") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."UQ_admin_user"`);
    await queryRunner.query(`ALTER TABLE "admin" ADD "role_id" uuid`);
    // El rol vuelve a copiarse desde el usuario, que es de donde sale.
    await queryRunner.query(
      `UPDATE "admin" a SET "role_id" = u."role_id" FROM "user" u WHERE u."user_id" = a."user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin" ALTER COLUMN "role_id" SET NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "delivery" ADD "isTraveling" text`);
    await queryRunner.query(
      `ALTER TABLE "admin" ADD CONSTRAINT "FK_fd32421f2d93414e46a8fcfd86b" FOREIGN KEY ("role_id") REFERENCES "role"("role_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }
}
