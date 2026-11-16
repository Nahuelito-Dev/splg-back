import { MigrationInterface, QueryRunner } from 'typeorm';

/** Conserva cuándo se intentó leer, incluso si el proveedor respondió inválido. */
export class IntentosDeLectura1795000000008 implements MigrationInterface {
  name = 'IntentosDeLectura1795000000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "document_reading" ADD "attempted_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `UPDATE "document_reading" SET "attempted_at" = "read_at" WHERE "read_at" IS NOT NULL AND ("input_tokens" > 0 OR "output_tokens" > 0 OR "cost_usd" > 0)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "document_reading" DROP COLUMN "attempted_at"`,
    );
  }
}
