import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El CUIT de la distribuidora se guarda sólo con dígitos (sin guiones ni
 * espacios), como el de proveedores y el de cuentas corrientes. Es el paso
 * previo al CHECK de formato (`CHK_distributor_cuit`).
 */
export class NormalizarCuitDeDistribuidora1792700000000
  implements MigrationInterface
{
  name = 'NormalizarCuitDeDistribuidora1792700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "distributor"
          SET "tax_id" = NULLIF(regexp_replace("tax_id", '[^0-9]', '', 'g'), '')
        WHERE "tax_id" IS NOT NULL`,
    );
  }

  public async down(): Promise<void> {
    // Los guiones que tenía el valor original no se pueden reconstruir.
  }
}
