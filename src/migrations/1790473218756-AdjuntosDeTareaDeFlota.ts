import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adjuntos de una tarea de flota (CU-136 a CU-139): la foto o el PDF de la
 * póliza, la VTV o la licencia. `migration:generate` también detectó un
 * cambio en `delivery` (`isEnabled`/`isAvailable`) ajeno a esta tarea —lo
 * está trabajando otro agente en paralelo sobre la misma base— y se excluyó
 * a mano: esta migración toca sólo lo de flota.
 */
export class AdjuntosDeTareaDeFlota1790473218756 implements MigrationInterface {
  name = 'AdjuntosDeTareaDeFlota1790473218756';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "maintenance_task_attachment" ("attachment_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "task_id" uuid NOT NULL, "distributor_id" uuid NOT NULL, "storage_key" character varying(255) NOT NULL, "original_name" character varying(255) NOT NULL, "mime_type" character varying(100) NOT NULL, "size_bytes" integer NOT NULL, "uploaded_by_user_id" uuid NOT NULL, "uploaded_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_368cf5b7606c8ff95e4b320c81d" PRIMARY KEY ("attachment_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_07f53564ec7d34fc7e69b96cab" ON "maintenance_task_attachment" ("distributor_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task_attachment" ADD CONSTRAINT "FK_d48d7736a7efef5c2a5c0b4b23d" FOREIGN KEY ("task_id") REFERENCES "maintenance_task"("task_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task_attachment" ADD CONSTRAINT "FK_07f53564ec7d34fc7e69b96cabf" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task_attachment" ADD CONSTRAINT "FK_a13e7424735660fa5a1865781c6" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "maintenance_task_attachment" DROP CONSTRAINT "FK_a13e7424735660fa5a1865781c6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task_attachment" DROP CONSTRAINT "FK_07f53564ec7d34fc7e69b96cabf"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task_attachment" DROP CONSTRAINT "FK_d48d7736a7efef5c2a5c0b4b23d"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_07f53564ec7d34fc7e69b96cab"`,
    );
    await queryRunner.query(`DROP TABLE "maintenance_task_attachment"`);
  }
}
