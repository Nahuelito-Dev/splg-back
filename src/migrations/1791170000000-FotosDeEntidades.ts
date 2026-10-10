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

export class FotosDeEntidades1791170000000 implements MigrationInterface {
  name = 'FotosDeEntidades1791170000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user" ADD "photo_key" character varying(512)`,
    );
    await queryRunner.query(
      `ALTER TABLE "car" ADD "photo_key" character varying(512)`,
    );
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder" ADD "photo_key" character varying(512)`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor" ADD "logo_key" character varying(512)`,
    );
    await queryRunner.query(
      `ALTER TABLE "incident" ADD "photo_key" character varying(512)`,
    );
  }

  /** Los objetos de S3 no se borran con la columna: van a `storage_orphan`. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await aLimpieza(queryRunner, 'incident', 'photo_key');
    await aLimpieza(queryRunner, 'distributor', 'logo_key');
    await aLimpieza(queryRunner, 'gas_cylinder', 'photo_key');
    await aLimpieza(queryRunner, 'car', 'photo_key');
    await aLimpieza(queryRunner, 'user', 'photo_key');
    await queryRunner.query(`ALTER TABLE "incident" DROP COLUMN "photo_key"`);
    await queryRunner.query(`ALTER TABLE "distributor" DROP COLUMN "logo_key"`);
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder" DROP COLUMN "photo_key"`,
    );
    await queryRunner.query(`ALTER TABLE "car" DROP COLUMN "photo_key"`);
    await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "photo_key"`);
  }
}
