import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bandeja de avisos de los administradores: `admin_notification` (una fila por
 * aviso y distribuidora, sin repetir `dedupe_key`) y `admin_notification_read`
 * (una fila por admin que ya lo leyó).
 */
export class BandejaDeAvisosDelAdmin1793500000000
  implements MigrationInterface
{
  name = 'BandejaDeAvisosDelAdmin1793500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "admin_notification" ("notification_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "kind" character varying(60) NOT NULL, "title" character varying(160) NOT NULL, "body" text NOT NULL, "link_entity" character varying(60), "link_id" character varying(64), "dedupe_key" character varying(200) NOT NULL, "email" boolean NOT NULL DEFAULT false, "emailed_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_admin_notification_dedupe" UNIQUE ("distributor_id", "dedupe_key"), CONSTRAINT "CHK_admin_notification_destino" CHECK (("link_entity" IS NULL) = ("link_id" IS NULL)), CONSTRAINT "CHK_admin_notification_texto" CHECK (btrim("kind") <> '' AND btrim("title") <> '' AND btrim("dedupe_key") <> ''), CONSTRAINT "PK_c8cc173f8a571f49ee45d7e6b3c" PRIMARY KEY ("notification_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_admin_notification_distribuidora" ON "admin_notification" ("distributor_id", "created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE TABLE "admin_notification_read" ("notification_id" uuid NOT NULL, "user_id" uuid NOT NULL, "read_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_18044eedf21ec1f2318ca1a562a" PRIMARY KEY ("notification_id", "user_id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin_notification" ADD CONSTRAINT "FK_418c1e644808730fcd6b29d97a0" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin_notification_read" ADD CONSTRAINT "FK_6f33170ac9fb46d193c3106557b" FOREIGN KEY ("notification_id") REFERENCES "admin_notification"("notification_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin_notification_read" ADD CONSTRAINT "FK_e5b02afb8b3e991df51ba3c2ea5" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "admin_notification_read"`);
    await queryRunner.query(`DROP TABLE "admin_notification"`);
  }
}
