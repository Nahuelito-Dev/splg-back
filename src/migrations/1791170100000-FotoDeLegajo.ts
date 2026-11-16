import { MigrationInterface, QueryRunner } from 'typeorm';

/** Anota las keys para borrar el objeto antes de perder la referencia. */
async function aLimpieza(
  queryRunner: QueryRunner,
  tabla: string,
  columna: string,
): Promise<void> {
  await queryRunner.query(
    `INSERT INTO "storage_orphan" ("storage_key", "kind", "status", "next_attempt_at")
     SELECT DISTINCT "${columna}", 'remove', 'pending', now()
       FROM "${tabla}" WHERE "${columna}" IS NOT NULL
     ON CONFLICT ("storage_key") DO UPDATE
       SET "kind" = 'remove', "status" = 'pending', "next_attempt_at" = now()`,
  );
}

export class FotoDeLegajo1791170100000 implements MigrationInterface {
  name = 'FotoDeLegajo1791170100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "employee" ADD "photo_key" character varying(512)`,
    );
  }

  /** El objeto de S3 no se borra con la columna: va a `storage_orphan`. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await aLimpieza(queryRunner, 'employee', 'photo_key');
    await queryRunner.query(`ALTER TABLE "employee" DROP COLUMN "photo_key"`);
  }
}
