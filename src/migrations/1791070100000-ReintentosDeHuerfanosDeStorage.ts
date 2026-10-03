import { MigrationInterface, QueryRunner } from 'typeorm';

export class ReintentosDeHuerfanosDeStorage1791070100000
  implements MigrationInterface
{
  name = 'ReintentosDeHuerfanosDeStorage1791070100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "storage_orphan" ADD "kind" character varying(10) NOT NULL DEFAULT 'remove'`,
    );
    await queryRunner.query(
      `ALTER TABLE "storage_orphan" ADD "status" character varying(10) NOT NULL DEFAULT 'pending'`,
    );
    await queryRunner.query(
      `ALTER TABLE "storage_orphan" ADD "next_attempt_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "storage_orphan" DROP COLUMN "next_attempt_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "storage_orphan" DROP COLUMN "status"`,
    );
    await queryRunner.query(`ALTER TABLE "storage_orphan" DROP COLUMN "kind"`);
  }
}
