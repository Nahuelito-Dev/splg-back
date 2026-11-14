import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Marca de empresa propia de la plataforma (`distributor.owned_by_platform`):
 * una distribuidora de prueba que el administrador general opera directo, sin
 * sesión de soporte. Nace apagada para todas las empresas existentes.
 */
export class EmpresaPropiaDeLaPlataforma1795000000031
  implements MigrationInterface
{
  name = 'EmpresaPropiaDeLaPlataforma1795000000031';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "distributor" ADD "owned_by_platform" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "distributor" DROP COLUMN "owned_by_platform"`,
    );
  }
}
