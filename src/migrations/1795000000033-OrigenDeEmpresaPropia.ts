import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Procedencia verificable de los datos de prueba. Las filas existentes quedan
 * deliberadamente en `false`: sólo la siembra controlada de plataforma puede
 * crear una empresa o una cuenta con esta marca.
 */
export class OrigenDeEmpresaPropia1795000000033 implements MigrationInterface {
  name = 'OrigenDeEmpresaPropia1795000000033';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "distributor" ADD "created_by_platform" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "user" ADD "created_by_platform" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN "created_by_platform"`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor" DROP COLUMN "created_by_platform"`,
    );
  }
}
