import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Medir el acierto de M3 y M2.
 *
 * - `repurchase_invitation`: los parámetros con los que se proyectó cuándo se
 *   le acaba el gas al cliente (`estimate_kg_per_day`, `estimate_orders_used`).
 *   La fecha proyectada ya se guardaba (`projected_depletion_at`). Nulos en
 *   las invitaciones anteriores.
 * - `maintenance_task.first_predicted_due_at`: la primera fecha proyectada del
 *   vencimiento por kilometraje, que no se pisa; las tareas que ya tenían
 *   predicción la toman como primera.
 *
 * La auditoría de las columnas nuevas la instala la siguiente
 * (`AuditoriaDelAciertoDeLasPredicciones`).
 */
export class AciertoDeLasPredicciones1795000000151
  implements MigrationInterface
{
  name = 'AciertoDeLasPredicciones1795000000151';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" ADD "estimate_kg_per_day" double precision`,
    );
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" ADD "estimate_orders_used" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" ADD CONSTRAINT "CHK_repurchase_invitation_parametros" CHECK (("estimate_kg_per_day" IS NULL OR "estimate_kg_per_day" > 0) AND ("estimate_orders_used" IS NULL OR "estimate_orders_used" >= 0))`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" ADD "first_predicted_due_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `UPDATE "maintenance_task" SET "first_predicted_due_at" = "predicted_due_at" WHERE "predicted_due_at" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" DROP COLUMN "first_predicted_due_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" DROP CONSTRAINT "CHK_repurchase_invitation_parametros"`,
    );
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" DROP COLUMN "estimate_orders_used"`,
    );
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" DROP COLUMN "estimate_kg_per_day"`,
    );
  }
}
