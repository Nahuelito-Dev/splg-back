import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Vehículo en uso por chofer (decisión de nahue del 30/09): tabla
 * `vehicle_assignment` con historial (assigned_at/released_at,
 * assigned_by/released_by, note) y los dos índices únicos parciales que son
 * la invariante de negocio a nivel de base — un solo registro ABIERTO
 * (`released_at IS NULL`) por vehículo y uno solo por chofer. También el
 * snapshot del vehículo con el que se entrega en `order`
 * (`vehicle_car_id`/`vehicle_patent`/`vehicle_brand`/`vehicle_model`),
 * mismo patrón que el snapshot de zona (`zone_name`/`zone_surcharge_*`).
 * Sólo agrega: tabla y columnas nuevas, nada destructivo.
 */
export class VehiculoEnUso1790809300892 implements MigrationInterface {
  name = 'VehiculoEnUso1790809300892';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "vehicle_assignment" ("assignment_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "car_id" uuid NOT NULL, "delivery_id" uuid NOT NULL, "assigned_at" TIMESTAMP WITH TIME ZONE NOT NULL, "released_at" TIMESTAMP WITH TIME ZONE, "assigned_by_user_id" uuid NOT NULL, "released_by_user_id" uuid, "note" text, CONSTRAINT "PK_03cbc11f348efffa59570945343" PRIMARY KEY ("assignment_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_1f986e62c32ac5ee2d8d7eb133" ON "vehicle_assignment" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_vehicle_assignment_delivery_abierta" ON "vehicle_assignment" ("delivery_id") WHERE "released_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_vehicle_assignment_car_abierta" ON "vehicle_assignment" ("car_id") WHERE "released_at" IS NULL`,
    );
    await queryRunner.query(`ALTER TABLE "order" ADD "vehicle_car_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "order" ADD "vehicle_patent" character varying(20)`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD "vehicle_brand" character varying(50)`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD "vehicle_model" character varying(50)`,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicle_assignment" ADD CONSTRAINT "FK_1f986e62c32ac5ee2d8d7eb1330" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicle_assignment" ADD CONSTRAINT "FK_e553214db24f1d24bf12185dbb6" FOREIGN KEY ("car_id") REFERENCES "car"("car_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicle_assignment" ADD CONSTRAINT "FK_10efb252b7fde3ea22e9151b677" FOREIGN KEY ("delivery_id") REFERENCES "delivery"("delivery_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicle_assignment" ADD CONSTRAINT "FK_a7cb484055004c370b38d80e880" FOREIGN KEY ("assigned_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicle_assignment" ADD CONSTRAINT "FK_57f3c92c944f83e9d5d9fb24257" FOREIGN KEY ("released_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "vehicle_assignment" DROP CONSTRAINT "FK_57f3c92c944f83e9d5d9fb24257"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicle_assignment" DROP CONSTRAINT "FK_a7cb484055004c370b38d80e880"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicle_assignment" DROP CONSTRAINT "FK_10efb252b7fde3ea22e9151b677"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicle_assignment" DROP CONSTRAINT "FK_e553214db24f1d24bf12185dbb6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicle_assignment" DROP CONSTRAINT "FK_1f986e62c32ac5ee2d8d7eb1330"`,
    );
    await queryRunner.query(`ALTER TABLE "order" DROP COLUMN "vehicle_model"`);
    await queryRunner.query(`ALTER TABLE "order" DROP COLUMN "vehicle_brand"`);
    await queryRunner.query(`ALTER TABLE "order" DROP COLUMN "vehicle_patent"`);
    await queryRunner.query(`ALTER TABLE "order" DROP COLUMN "vehicle_car_id"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_vehicle_assignment_car_abierta"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_vehicle_assignment_delivery_abierta"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_1f986e62c32ac5ee2d8d7eb133"`,
    );
    await queryRunner.query(`DROP TABLE "vehicle_assignment"`);
  }
}
