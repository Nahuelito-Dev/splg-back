import { MigrationInterface, QueryRunner } from 'typeorm';

export class FotoDeReclamoYHuerfanosDeStorage1791070000000
  implements MigrationInterface
{
  name = 'FotoDeReclamoYHuerfanosDeStorage1791070000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "claims" ADD "photo_key" character varying(512)`,
    );
    await queryRunner.query(
      `CREATE TABLE "storage_orphan" ("orphan_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "storage_key" character varying(512) NOT NULL, "attempts" integer NOT NULL DEFAULT '0', "last_error" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_79763cafe43e9dcf31ea86b6f59" UNIQUE ("storage_key"), CONSTRAINT "PK_7875e03a159e8f5bbc0ddc30c1a" PRIMARY KEY ("orphan_id"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "storage_orphan"`);
    await queryRunner.query(`ALTER TABLE "claims" DROP COLUMN "photo_key"`);
  }
}
