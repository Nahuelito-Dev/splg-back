import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  sentenciasDeRolesDelPersonal,
  sentenciasParaQuitarRolesDelPersonal,
} from './sql/roles-del-personal';

/**
 * Roles del personal del panel (F37 E1). Crea `staff_role` y `admin.staff_role_id`,
 * los únicos, la función que asegura el rol de sistema «Administrador» y los
 * triggers que lo crean con cada distribuidora y lo asignan a cada admin nuevo
 * sin rol. La auditoría de la tabla nueva la instala `AuditoriaDeLosRolesDelPersonal`
 * y la siembra de los datos que ya existen, `SembrarRolesDelPersonal` (después,
 * para que quede auditada).
 */
export class RolesDelPersonal1795000000020 implements MigrationInterface {
  name = 'RolesDelPersonal1795000000020';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "staff_role" ("staff_role_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "name" character varying(60) NOT NULL, "description" character varying(300), "permissions" text array NOT NULL DEFAULT '{}', "is_system" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_staff_role_id_distribuidora" UNIQUE ("staff_role_id", "distributor_id"), CONSTRAINT "CHK_staff_role_sistema_sin_lista" CHECK (NOT "is_system" OR cardinality("permissions") = 0), CONSTRAINT "CHK_staff_role_nombre" CHECK (char_length(btrim("name")) >= 2), CONSTRAINT "PK_a1b2b06f43748b2d1e3a9a72c4c" PRIMARY KEY ("staff_role_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_53648e1e22cdfe2210139441eb" ON "staff_role" ("distributor_id") `,
    );
    await queryRunner.query(`ALTER TABLE "admin" ADD "staff_role_id" uuid`);
    await queryRunner.query(
      `CREATE INDEX "IDX_7c9789256eb364d5021be3ff60" ON "admin" ("staff_role_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "staff_role" ADD CONSTRAINT "FK_53648e1e22cdfe2210139441eb5" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin" ADD CONSTRAINT "FK_7c9789256eb364d5021be3ff609" FOREIGN KEY ("staff_role_id") REFERENCES "staff_role"("staff_role_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin" ADD CONSTRAINT "FK_admin_staff_role_distribuidora" FOREIGN KEY ("staff_role_id", "distributor_id") REFERENCES "staff_role"("staff_role_id","distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    for (const sql of sentenciasDeRolesDelPersonal()) {
      await queryRunner.query(sql);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of sentenciasParaQuitarRolesDelPersonal()) {
      await queryRunner.query(sql);
    }
    await queryRunner.query(
      `ALTER TABLE "admin" DROP CONSTRAINT "FK_admin_staff_role_distribuidora"`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin" DROP CONSTRAINT "FK_7c9789256eb364d5021be3ff609"`,
    );
    await queryRunner.query(
      `ALTER TABLE "staff_role" DROP CONSTRAINT "FK_53648e1e22cdfe2210139441eb5"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_7c9789256eb364d5021be3ff60"`,
    );
    await queryRunner.query(`ALTER TABLE "admin" DROP COLUMN "staff_role_id"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_53648e1e22cdfe2210139441eb"`,
    );
    await queryRunner.query(`DROP TABLE "staff_role"`);
  }
}
