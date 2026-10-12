import { MigrationInterface, QueryRunner } from 'typeorm';

export class CargaCamion1791765958400 implements MigrationInterface {
  name = 'CargaCamion1791765958400';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "truck_load_item" ("item_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "load_id" uuid NOT NULL, "gas_cylinder_id" uuid NOT NULL, "loaded_full" integer NOT NULL DEFAULT '0', "reloaded_full" integer NOT NULL DEFAULT '0', "loaded_empty" integer NOT NULL DEFAULT '0', "declared_return_full" integer, "declared_return_empty" integer, "delivered_full" integer, "collected_empty" integer, "expected_full" integer, "expected_empty" integer, "difference_full" integer, "difference_empty" integer, CONSTRAINT "CHK_truck_load_item_declarado" CHECK (("declared_return_full" IS NULL OR "declared_return_full" >= 0) AND ("declared_return_empty" IS NULL OR "declared_return_empty" >= 0)), CONSTRAINT "CHK_truck_load_item_cargado" CHECK ("loaded_full" >= 0 AND "reloaded_full" >= 0 AND "loaded_empty" >= 0), CONSTRAINT "PK_bad04888d48307d2e2cefb5e4ab" PRIMARY KEY ("item_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_truck_load_item_garrafa" ON "truck_load_item" ("gas_cylinder_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_truck_load_item_garrafa" ON "truck_load_item" ("load_id", "gas_cylinder_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."truck_load_status_enum" AS ENUM('loading', 'on_route', 'returned', 'closed', 'closed_with_difference', 'cancelled')`,
    );
    await queryRunner.query(
      `CREATE TABLE "truck_load" ("load_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "number" integer NOT NULL, "car_id" uuid NOT NULL, "delivery_id" uuid NOT NULL, "helper_employee_id" uuid, "origin_location_id" uuid NOT NULL, "business_date" date NOT NULL, "status" "public"."truck_load_status_enum" NOT NULL DEFAULT 'loading', "opened_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "departed_at" TIMESTAMP WITH TIME ZONE, "returned_at" TIMESTAMP WITH TIME ZONE, "closed_at" TIMESTAMP WITH TIME ZONE, "opened_by_user_id" uuid NOT NULL, "closed_by_user_id" uuid, "difference_note" text, "cancel_reason" text, "notes" text, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_3dbdc80ba4676ee68d818791f34" PRIMARY KEY ("load_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_truck_load_camion" ON "truck_load" ("car_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_truck_load_chofer" ON "truck_load" ("delivery_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_truck_load_estado" ON "truck_load" ("distributor_id", "status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_truck_load_fecha" ON "truck_load" ("distributor_id", "business_date") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_truck_load_chofer_abierta" ON "truck_load" ("delivery_id") WHERE "status" IN ('loading', 'on_route', 'returned')`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_truck_load_camion_abierta" ON "truck_load" ("car_id") WHERE "status" IN ('loading', 'on_route', 'returned')`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_truck_load_numero" ON "truck_load" ("distributor_id", "number") `,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."configurable_process_enum" ADD VALUE IF NOT EXISTS 'stock_control'`,
    );
    await queryRunner.query(
      `ALTER TABLE "truck_load_item" ADD CONSTRAINT "FK_440db97a6d338b1392d613087c6" FOREIGN KEY ("load_id") REFERENCES "truck_load"("load_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "truck_load_item" ADD CONSTRAINT "FK_aab2bf3823dbe43254226112845" FOREIGN KEY ("gas_cylinder_id") REFERENCES "gas_cylinder"("gas_cylinder_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "truck_load" ADD CONSTRAINT "FK_c023820beebd76607bbe400ba17" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "truck_load" ADD CONSTRAINT "FK_587a7d9c99ceae48a3642c8d4bb" FOREIGN KEY ("car_id") REFERENCES "car"("car_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "truck_load" ADD CONSTRAINT "FK_b075736a27f0d8accf03d6412a9" FOREIGN KEY ("delivery_id") REFERENCES "delivery"("delivery_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "truck_load" ADD CONSTRAINT "FK_30e302bc956545af9282a1c43c4" FOREIGN KEY ("helper_employee_id") REFERENCES "employee"("employee_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "truck_load" ADD CONSTRAINT "FK_b446f9041a2b069fabf41a1ee5e" FOREIGN KEY ("origin_location_id") REFERENCES "stock_location"("location_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "truck_load" ADD CONSTRAINT "FK_3b6b13c2d3f23575097fca51f2b" FOREIGN KEY ("opened_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "truck_load" ADD CONSTRAINT "FK_4d54b2fe75eceaccd133cd852c8" FOREIGN KEY ("closed_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "truck_load" DROP CONSTRAINT "FK_4d54b2fe75eceaccd133cd852c8"`,
    );
    await queryRunner.query(
      `ALTER TABLE "truck_load" DROP CONSTRAINT "FK_3b6b13c2d3f23575097fca51f2b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "truck_load" DROP CONSTRAINT "FK_b446f9041a2b069fabf41a1ee5e"`,
    );
    await queryRunner.query(
      `ALTER TABLE "truck_load" DROP CONSTRAINT "FK_30e302bc956545af9282a1c43c4"`,
    );
    await queryRunner.query(
      `ALTER TABLE "truck_load" DROP CONSTRAINT "FK_b075736a27f0d8accf03d6412a9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "truck_load" DROP CONSTRAINT "FK_587a7d9c99ceae48a3642c8d4bb"`,
    );
    await queryRunner.query(
      `ALTER TABLE "truck_load" DROP CONSTRAINT "FK_c023820beebd76607bbe400ba17"`,
    );
    await queryRunner.query(
      `ALTER TABLE "truck_load_item" DROP CONSTRAINT "FK_aab2bf3823dbe43254226112845"`,
    );
    await queryRunner.query(
      `ALTER TABLE "truck_load_item" DROP CONSTRAINT "FK_440db97a6d338b1392d613087c6"`,
    );
    await queryRunner.query(
      `DELETE FROM "module_config" WHERE "module" = 'stock_control'`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "UQ_module_config_distributor_module"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."configurable_process_enum_old" AS ENUM('fleet_planner', 'repurchase', 'route_batching', 'cylinder_recovery', 'express_dispatch')`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" ALTER COLUMN "module" TYPE "public"."configurable_process_enum_old" USING "module"::"text"::"public"."configurable_process_enum_old"`,
    );
    await queryRunner.query(`DROP TYPE "public"."configurable_process_enum"`);
    await queryRunner.query(
      `ALTER TYPE "public"."configurable_process_enum_old" RENAME TO "configurable_process_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "UQ_module_config_distributor_module" UNIQUE ("distributor_id", "module")`,
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_truck_load_numero"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_truck_load_camion_abierta"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_truck_load_chofer_abierta"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_truck_load_fecha"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_truck_load_estado"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_truck_load_chofer"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_truck_load_camion"`);
    await queryRunner.query(`DROP TABLE "truck_load"`);
    await queryRunner.query(`DROP TYPE "public"."truck_load_status_enum"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_truck_load_item_garrafa"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_truck_load_item_garrafa"`,
    );
    await queryRunner.query(`DROP TABLE "truck_load_item"`);
  }
}
