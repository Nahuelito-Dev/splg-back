import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLAS = ['supplier', 'cylinder', 'truck_load'];

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

export class FotoDeProveedorEnvaseYCarga1793400000000
  implements MigrationInterface
{
  name = 'FotoDeProveedorEnvaseYCarga1793400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const tabla of TABLAS) {
      await queryRunner.query(
        `ALTER TABLE "${tabla}" ADD "photo_key" character varying(512)`,
      );
    }
  }

  /** Los objetos de S3 no se borran con la columna: van a `storage_orphan`. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const tabla of TABLAS) {
      await aLimpieza(queryRunner, tabla, 'photo_key');
      await queryRunner.query(`ALTER TABLE "${tabla}" DROP COLUMN "photo_key"`);
    }
  }
}
