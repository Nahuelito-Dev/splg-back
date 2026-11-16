import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hoja de ruta (M4, modalidad `planned`): los valores de enum nuevos. Van en su
 * propia migración porque un valor de enum recién agregado no se puede usar en
 * la transacción que lo agrega, y la siguiente migración lo usa en sus CHECK.
 * `draft` y `confirmed` se ubican donde están en la entidad.
 */
export class HojaDeRutaEnums1794800000000 implements MigrationInterface {
  name = 'HojaDeRutaEnums1794800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."route_batch_status_enum" ADD VALUE IF NOT EXISTS 'draft' AFTER 'offered'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."route_batch_status_enum" ADD VALUE IF NOT EXISTS 'confirmed' AFTER 'draft'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."route_batch_close_reason_enum" ADD VALUE IF NOT EXISTS 'day_closed'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."configurable_process_enum" ADD VALUE IF NOT EXISTS 'route_planning'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres no quita valores de un enum; los valores sobrantes no molestan.
  }
}
