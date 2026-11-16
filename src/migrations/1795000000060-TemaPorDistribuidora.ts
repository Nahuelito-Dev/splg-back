import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tema por distribuidora (diseño de la plataforma, §4.8): `distributor_theme`,
 * 1:1 con `distributor` (la PK es la FK). Color principal y acento en
 * `#RRGGBB` mayúsculas, nombre para mostrar de 2 a 60 caracteres, tokens y
 * contraste que calcula el back, `version` que sólo sube y baja lógica
 * (`deleted_at`) para «Restablecer». La auditoría la instala
 * `AuditoriaDelTemaPorDistribuidora`.
 */
export class TemaPorDistribuidora1795000000060 implements MigrationInterface {
  name = 'TemaPorDistribuidora1795000000060';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "distributor_theme" ("distributor_id" uuid NOT NULL, "primary_color" character(7) NOT NULL, "accent_color" character(7), "display_name" character varying(60), "tokens" jsonb NOT NULL, "contrast" jsonb NOT NULL, "version" integer NOT NULL DEFAULT '1', "updated_by" uuid, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "CHK_distributor_theme_version" CHECK ("version" >= 1), CONSTRAINT "CHK_distributor_theme_nombre" CHECK ("display_name" IS NULL OR char_length(btrim("display_name")) BETWEEN 2 AND 60), CONSTRAINT "CHK_distributor_theme_acento" CHECK ("accent_color" IS NULL OR "accent_color" ~ '^#[0-9A-F]{6}$'), CONSTRAINT "CHK_distributor_theme_primario" CHECK ("primary_color" ~ '^#[0-9A-F]{6}$'), CONSTRAINT "PK_0df2eeec89a0ca5a89d51cb40a7" PRIMARY KEY ("distributor_id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor_theme" ADD CONSTRAINT "FK_0df2eeec89a0ca5a89d51cb40a7" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor_theme" ADD CONSTRAINT "FK_5f1985135a56c9384a63b094e05" FOREIGN KEY ("updated_by") REFERENCES "user"("user_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "distributor_theme" DROP CONSTRAINT "FK_5f1985135a56c9384a63b094e05"`,
    );
    await queryRunner.query(
      `ALTER TABLE "distributor_theme" DROP CONSTRAINT "FK_0df2eeec89a0ca5a89d51cb40a7"`,
    );
    await queryRunner.query(`DROP TABLE "distributor_theme"`);
  }
}
