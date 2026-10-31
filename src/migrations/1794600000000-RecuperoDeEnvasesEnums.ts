import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Recupero de envases (CU-108): el estado «perdido» del caso. Va en su propia
 * migración porque un valor nuevo de un enum no se puede usar en la transacción
 * que lo agrega y la siguiente migración lo usa en sus restricciones.
 */
export class RecuperoDeEnvasesEnums1794600000000 implements MigrationInterface {
  name = 'RecuperoDeEnvasesEnums1794600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."recovery_case_status_enum" ADD VALUE IF NOT EXISTS 'lost'`,
    );
  }

  public async down(): Promise<void> {
    // Un valor de enum no se quita sin recrear el tipo; sobra inofensivo.
  }
}
