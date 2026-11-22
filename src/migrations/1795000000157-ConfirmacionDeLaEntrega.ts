import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Prueba de la entrega confirmada por el chofer con el código del cliente:
 * dónde estaba (punto y precisión), a cuántos metros del domicilio, si quedó
 * fuera del radio de llegada y quién confirmó (usuario y rol).
 */
export class ConfirmacionDeLaEntrega1795000000157
  implements MigrationInterface
{
  name = 'ConfirmacionDeLaEntrega1795000000157';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order" ADD "delivery_confirmed_point" geography(Point,4326)`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD "delivery_confirmed_accuracy_m" numeric(8,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD "delivery_confirmed_distance_m" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD "delivery_confirmed_out_of_range" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD "delivery_confirmed_by_user_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD "delivery_confirmed_by_role" character varying(20)`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD CONSTRAINT "CHK_order_confirmacion_con_entrega" CHECK ("delivery_confirmed_point" IS NULL OR "deliveredAt" IS NOT NULL)`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD CONSTRAINT "CHK_order_confirmacion_precision" CHECK ("delivery_confirmed_accuracy_m" IS NULL OR ("delivery_confirmed_accuracy_m" >= 0 AND "delivery_confirmed_accuracy_m" <= 10000))`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD CONSTRAINT "CHK_order_confirmacion_distancia" CHECK ("delivery_confirmed_distance_m" IS NULL OR "delivery_confirmed_distance_m" >= 0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD CONSTRAINT "CHK_order_confirmacion_fuera_de_radio" CHECK (NOT "delivery_confirmed_out_of_range" OR "delivery_confirmed_point" IS NOT NULL)`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD CONSTRAINT "CHK_order_confirmacion_rol" CHECK ("delivery_confirmed_by_role" IS NULL OR "delivery_confirmed_by_role" IN ('delivery', 'admin', 'super_admin'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD CONSTRAINT "FK_order_delivery_confirmed_by" FOREIGN KEY ("delivery_confirmed_by_user_id") REFERENCES "user" ("user_id") ON DELETE RESTRICT`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order" DROP CONSTRAINT "FK_order_delivery_confirmed_by"`,
    );
    for (const c of [
      'CHK_order_confirmacion_rol',
      'CHK_order_confirmacion_fuera_de_radio',
      'CHK_order_confirmacion_distancia',
      'CHK_order_confirmacion_precision',
      'CHK_order_confirmacion_con_entrega',
    ]) {
      await queryRunner.query(`ALTER TABLE "order" DROP CONSTRAINT "${c}"`);
    }
    for (const col of [
      'delivery_confirmed_by_role',
      'delivery_confirmed_by_user_id',
      'delivery_confirmed_out_of_range',
      'delivery_confirmed_distance_m',
      'delivery_confirmed_accuracy_m',
      'delivery_confirmed_point',
    ]) {
      await queryRunner.query(`ALTER TABLE "order" DROP COLUMN "${col}"`);
    }
  }
}
