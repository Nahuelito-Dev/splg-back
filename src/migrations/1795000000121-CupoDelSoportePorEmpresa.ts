import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cupo mensual de tokens del asistente con IA de cada empresa en el soporte
 * (C1), dentro del tope de la plataforma: una empresa que lo agota recibe
 * sólo la capa fija y derivar, sin dejar al resto sin asistente.
 *
 * Al migrar, el cupo arranca igual al tope total vigente (no recorta a
 * nadie; el superadmin lo baja si quiere). El CHECK no deja que supere el
 * total.
 */
export class CupoDelSoportePorEmpresa1795000000121
  implements MigrationInterface
{
  name = 'CupoDelSoportePorEmpresa1795000000121';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "platform_support_settings" ADD "assistant_monthly_token_limit_per_company" integer NOT NULL DEFAULT '2000000'`,
    );
    await queryRunner.query(
      `UPDATE "platform_support_settings" SET "assistant_monthly_token_limit_per_company" = "assistant_monthly_token_limit"`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_support_settings" ADD CONSTRAINT "CHK_platform_support_settings_cupo_por_empresa" CHECK ("assistant_monthly_token_limit_per_company" BETWEEN 10000 AND 1000000000 AND "assistant_monthly_token_limit_per_company" <= "assistant_monthly_token_limit")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "platform_support_settings" DROP CONSTRAINT "CHK_platform_support_settings_cupo_por_empresa"`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_support_settings" DROP COLUMN "assistant_monthly_token_limit_per_company"`,
    );
  }
}
