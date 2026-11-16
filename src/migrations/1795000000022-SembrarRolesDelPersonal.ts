import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Siembra del rol de sistema «Administrador» (F37 E1) en todas las
 * distribuidoras que ya existen (también las dadas de baja: sus admins
 * necesitan rol igual) y su asignación a los admins de cada una. Corre después
 * de `AuditoriaDeLosRolesDelPersonal`, así queda asentada en la auditoría. Recién
 * con todos asignados se exige el rol a todo admin con distribuidora.
 */
export class SembrarRolesDelPersonal1795000000022
  implements MigrationInterface
{
  name = 'SembrarRolesDelPersonal1795000000022';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `SELECT staff_role_de_sistema("distributor_id") FROM "distributor"`,
    );
    await queryRunner.query(
      `UPDATE "admin" SET "staff_role_id" = staff_role_de_sistema("distributor_id")
        WHERE "distributor_id" IS NOT NULL AND "staff_role_id" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin" ADD CONSTRAINT "CHK_admin_rol_de_personal" CHECK (("distributor_id" IS NULL) = ("staff_role_id" IS NULL))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Los roles sembrados quedan: se van con la tabla al deshacer `RolesDelPersonal`.
    await queryRunner.query(
      `ALTER TABLE "admin" DROP CONSTRAINT "CHK_admin_rol_de_personal"`,
    );
  }
}
