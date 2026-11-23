import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Seguros: el aviso de la cuota a 5 días pide la aprobación del pago al admin.
 * La cuota guarda su estado de aprobación (`none`, `awaiting`, `approved`) y,
 * al aprobarse, quién y cuándo. La base exige que el estado y esos datos sean
 * coherentes.
 */
export class AprobacionDelPagoDeLasCuotas1795000000161
  implements MigrationInterface
{
  name = 'AprobacionDelPagoDeLasCuotas1795000000161';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."insurance_installment_approval_status_enum" AS ENUM('none', 'awaiting', 'approved')`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" ADD "approval_status" "public"."insurance_installment_approval_status_enum" NOT NULL DEFAULT 'none'`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" ADD "approval_requested_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" ADD "approved_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" ADD "approved_by_user_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" ADD CONSTRAINT "FK_insurance_installment_approved_by" FOREIGN KEY ("approved_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" ADD CONSTRAINT "CHK_insurance_installment_aprobacion" CHECK (("approval_status" = 'none' AND num_nonnulls("approval_requested_at", "approved_at", "approved_by_user_id") = 0) OR ("approval_status" = 'awaiting' AND "approval_requested_at" IS NOT NULL AND num_nonnulls("approved_at", "approved_by_user_id") = 0) OR ("approval_status" = 'approved' AND num_nonnulls("approval_requested_at", "approved_at", "approved_by_user_id") = 3))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" DROP CONSTRAINT "CHK_insurance_installment_aprobacion"`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" DROP CONSTRAINT "FK_insurance_installment_approved_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" DROP COLUMN "approved_by_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" DROP COLUMN "approved_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" DROP COLUMN "approval_requested_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" DROP COLUMN "approval_status"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."insurance_installment_approval_status_enum"`,
    );
  }
}
