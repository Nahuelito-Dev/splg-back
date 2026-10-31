import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Recompra anticipada (M3): el estado «cancelada» de la invitación (el cliente
 * compró por su cuenta mientras corría). Va en su propia migración porque un
 * valor de enum nuevo no se puede usar en la transacción que lo agrega.
 */
export class RecompraM3Enums1794500000000 implements MigrationInterface {
  name = 'RecompraM3Enums1794500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."repurchase_invitation_status_enum" ADD VALUE IF NOT EXISTS 'cancelled'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres no quita valores de un enum; el valor sobrante no molesta.
  }
}
