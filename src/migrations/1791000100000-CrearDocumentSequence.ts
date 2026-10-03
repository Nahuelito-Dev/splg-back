import { MigrationInterface, QueryRunner } from 'typeorm';

export class CrearDocumentSequence1791000100000 implements MigrationInterface {
  name = 'CrearDocumentSequence1791000100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "document_sequence" (
        "distributor_id" uuid NOT NULL,
        "doc_type" character varying(40) NOT NULL,
        "last_number" integer NOT NULL DEFAULT '0',
        CONSTRAINT "PK_document_sequence" PRIMARY KEY ("distributor_id", "doc_type")
      )`,
    );
    await queryRunner.query(
      `ALTER TABLE "document_sequence" ADD CONSTRAINT "FK_document_sequence_distributor" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "document_sequence"`);
  }
}
