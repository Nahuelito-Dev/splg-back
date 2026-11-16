import { MigrationInterface, QueryRunner } from 'typeorm';

export class AdjuntosBajaLogica1791100300000 implements MigrationInterface {
  name = 'AdjuntosBajaLogica1791100300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "attachment" ADD "deleted_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task_attachment" ADD "deleted_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "maintenance_task_attachment" DROP COLUMN "deleted_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" DROP COLUMN "deleted_at"`,
    );
  }
}
