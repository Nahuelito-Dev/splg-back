import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El asistente de cada distribuidora (DISENO-CH-BOT B1, D-B8): su nombre, con
 * el que se firman las respuestas automáticas, y lo que dice al pasar la
 * conversación a una persona. Nulos: los textos de siempre.
 *
 * `unaccent` es para las sugerencias de respuesta de la bandeja (búsqueda de
 * texto en castellano sin tildes, sin IA). Es una extensión «trusted» desde
 * Postgres 13: la crea el dueño de la base sin ser superusuario.
 */
export class AsistenteDeLaEmpresa1795000000114 implements MigrationInterface {
  name = 'AsistenteDeLaEmpresa1795000000114';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS unaccent`);
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" ADD "assistant_name" character varying(60)`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" ADD "handoff_message" character varying(500)`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" ADD CONSTRAINT "CHK_chat_company_settings_asistente" CHECK ("assistant_name" IS NULL OR (char_length(btrim("assistant_name")) BETWEEN 2 AND 60 AND "assistant_name" !~ '[[:cntrl:]]'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" ADD CONSTRAINT "CHK_chat_company_settings_derivacion" CHECK ("handoff_message" IS NULL OR char_length(btrim("handoff_message")) BETWEEN 1 AND 500)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" DROP CONSTRAINT "CHK_chat_company_settings_derivacion"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" DROP CONSTRAINT "CHK_chat_company_settings_asistente"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" DROP COLUMN "handoff_message"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_company_settings" DROP COLUMN "assistant_name"`,
    );
    // La extensión queda: no guarda datos y otra cosa pudo empezar a usarla.
  }
}
