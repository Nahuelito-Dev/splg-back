import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Flota ampliada (C-18): cargas de combustible, multas, siniestros y
 * neumáticos; el combustible y el tanque del vehículo; el inicio de vigencia
 * de las tareas; qué documento es cada plan (`document_kind`) y la
 * habilitación para transportar mercancías peligrosas (CU-197) como plan base
 * de las distribuidoras que ya existen.
 *
 * `fuel_type_enum` lo comparten `car` y `fuel_load`: se crea una sola vez.
 */
export class FlotaAmpliada1792186500123 implements MigrationInterface {
  name = 'FlotaAmpliada1792186500123';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."traffic_fine_status_enum" AS ENUM('pending', 'appealed', 'paid', 'voided')`,
    );
    await queryRunner.query(
      `CREATE TABLE "traffic_fine" ("fine_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "car_id" uuid NOT NULL, "employee_id" uuid, "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL, "jurisdiction" character varying(80) NOT NULL, "act_number" character varying(40) NOT NULL, "infraction" text NOT NULL, "amount" numeric(12,2) NOT NULL, "voluntary_payment_amount" numeric(12,2), "due_date" date, "status" "public"."traffic_fine_status_enum" NOT NULL DEFAULT 'pending', "paid_at" TIMESTAMP WITH TIME ZONE, "paid_amount" numeric(12,2), "charged_to_employee" boolean NOT NULL DEFAULT false, "void_reason" text, "voided_at" TIMESTAMP WITH TIME ZONE, "alerted_at" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_traffic_fine_amount" CHECK ("amount" > 0), CONSTRAINT "PK_070a6dff8acb17a6bbfecad41df" PRIMARY KEY ("fine_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_traffic_fine_status_due" ON "traffic_fine" ("distributor_id", "status", "due_date") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_traffic_fine_car" ON "traffic_fine" ("car_id", "occurred_at") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_traffic_fine_act" ON "traffic_fine" ("distributor_id", "jurisdiction", "act_number") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."vehicle_accident_status_enum" AS ENUM('reported', 'under_review', 'repairing', 'closed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "vehicle_accident" ("accident_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "car_id" uuid NOT NULL, "employee_id" uuid, "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL, "location" geometry(Point,4326), "address" text, "description" text NOT NULL, "injuries" boolean NOT NULL DEFAULT false, "third_parties_involved" boolean NOT NULL DEFAULT false, "hazmat_release" boolean NOT NULL DEFAULT false, "police_report_number" character varying(40), "insurer_claim_number" character varying(40), "status" "public"."vehicle_accident_status_enum" NOT NULL DEFAULT 'reported', "vehicle_unusable" boolean NOT NULL DEFAULT false, "repair_cost" numeric(12,2), "insurer_reimbursement" numeric(12,2), "deductible_amount" numeric(12,2), "closed_at" TIMESTAMP WITH TIME ZONE, "created_by_user_id" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_c6448a95ffc706c4e8c25d007f1" PRIMARY KEY ("accident_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_vehicle_accident_status" ON "vehicle_accident" ("distributor_id", "status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_vehicle_accident_car" ON "vehicle_accident" ("car_id", "occurred_at") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."tire_status_enum" AS ENUM('in_stock', 'mounted', 'retired')`,
    );
    await queryRunner.query(
      `CREATE TABLE "tire" ("tire_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "serial_number" character varying(60) NOT NULL, "brand" character varying(60) NOT NULL, "size" character varying(40) NOT NULL, "cost" numeric(12,2) NOT NULL, "status" "public"."tire_status_enum" NOT NULL DEFAULT 'in_stock', "car_id" uuid, "position" character varying(6), "mounted_odometer_km" integer, "km_traveled" integer NOT NULL DEFAULT '0', "retread_count" integer NOT NULL DEFAULT '0', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_1cd585e4893980c1fdc669df3da" PRIMARY KEY ("tire_id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_tire_posicion_ocupada" ON "tire" ("car_id", "position") WHERE "status" = 'mounted'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_tire_serial" ON "tire" ("distributor_id", "serial_number") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."tire_event_type_enum" AS ENUM('mount', 'unmount', 'rotate', 'retread', 'retire')`,
    );
    await queryRunner.query(
      `CREATE TABLE "tire_event" ("event_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tire_id" uuid NOT NULL, "distributor_id" uuid NOT NULL, "type" "public"."tire_event_type_enum" NOT NULL, "car_id" uuid, "position" character varying(6), "odometer_km" integer NOT NULL, "created_by_user_id" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_8f948fe5b4246a2a92915126dad" PRIMARY KEY ("event_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_tire_event_tire" ON "tire_event" ("tire_id", "createdAt") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."fuel_type_enum" AS ENUM('diesel', 'gasoline', 'cng', 'lpg')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."fuel_payment_method_enum" AS ENUM('cash_box', 'driver_cash', 'card', 'fuel_account')`,
    );
    await queryRunner.query(
      `CREATE TABLE "fuel_load" ("fuel_load_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "car_id" uuid NOT NULL, "employee_id" uuid, "loaded_at" TIMESTAMP WITH TIME ZONE NOT NULL, "fuel_type" "public"."fuel_type_enum" NOT NULL, "liters" numeric(10,2) NOT NULL, "unit_price" numeric(12,3) NOT NULL, "total_amount" numeric(12,2) NOT NULL, "odometer_km" integer NOT NULL, "is_full_tank" boolean NOT NULL DEFAULT true, "station" character varying(120), "payment_method" "public"."fuel_payment_method_enum" NOT NULL, "receipt_number" character varying(40), "anomaly" boolean NOT NULL DEFAULT false, "notes" text, "odometer_correction_note" text, "created_by_user_id" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "CHK_fuel_load_total" CHECK ("total_amount" >= 0), CONSTRAINT "CHK_fuel_load_liters" CHECK ("liters" > 0), CONSTRAINT "PK_365d58e595b7370dd809570d41e" PRIMARY KEY ("fuel_load_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fuel_load_distributor_loaded_at" ON "fuel_load" ("distributor_id", "loaded_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fuel_load_car_loaded_at" ON "fuel_load" ("car_id", "loaded_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "car" ADD "fuel_type" "public"."fuel_type_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "car" ADD "tank_capacity_liters" numeric(6,2)`,
    );
    // `document_kind` lo comparte la documentación del personal
    // (DocumentacionAsistenciaYLicenciasDelPersonal), que en una base nueva
    // corre antes y lo crea con todos los tipos: acá sólo se crea si falta.
    const columnaDelPlan = (await queryRunner.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'maintenance_plan' AND column_name = 'document_kind'`,
    )) as unknown[];
    if (columnaDelPlan.length === 0) {
      await queryRunner.query(
        `CREATE TYPE "public"."plan_document_kind_enum" AS ENUM('insurance', 'vtv', 'hazmat_vehicle_permit')`,
      );
      await queryRunner.query(
        `ALTER TABLE "maintenance_plan" ADD "document_kind" "public"."plan_document_kind_enum"`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" ADD "valid_from" TIMESTAMP WITH TIME ZONE`,
    );

    // Los planes que el sistema reconoce por su documento. Las distribuidoras
    // que ya existían los tienen por nombre (los sembró SembrarPlanesBaseDeFlota).
    await queryRunner.query(
      `UPDATE "maintenance_plan" SET "document_kind" = 'insurance' WHERE "name" = 'Seguro del vehículo' AND "document_kind" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "maintenance_plan" SET "document_kind" = 'vtv' WHERE "name" = 'VTV' AND "document_kind" IS NULL`,
    );
    // CU-197: el plan de la habilitación de mercancías peligrosas, para las
    // distribuidoras existentes. Las nuevas lo reciben con los planes base
    // (`BASE_PLAN_DEFINITIONS`): mismos valores en los dos lados.
    await queryRunner.query(`
      INSERT INTO "maintenance_plan"
        ("plan_id", "distributor_id", "name", "subject", "trigger", "interval_km", "interval_months", "lead_time_days", "criticality", "car_type", "is_active", "document_kind")
      SELECT
        uuid_generate_v4(), d."distributor_id", 'Habilitación para transporte de mercancías peligrosas',
        'vehicle'::"maintenance_subject_enum", 'by_fixed_date'::"maintenance_trigger_enum", NULL, NULL, 30,
        'blocking'::"maintenance_criticality_enum", NULL, true, 'hazmat_vehicle_permit'::"plan_document_kind_enum"
      FROM "distributor" d
      WHERE NOT EXISTS (
        SELECT 1 FROM "maintenance_plan" mp
        WHERE mp."distributor_id" = d."distributor_id"
          AND mp."name" = 'Habilitación para transporte de mercancías peligrosas'
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "traffic_fine" ADD CONSTRAINT "FK_5d3ee796a650efff7dc859091cf" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "traffic_fine" ADD CONSTRAINT "FK_367a6b8c0709f0a75bb2102ed37" FOREIGN KEY ("car_id") REFERENCES "car"("car_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "traffic_fine" ADD CONSTRAINT "FK_61447819bfe7d42839be95fb820" FOREIGN KEY ("employee_id") REFERENCES "employee"("employee_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicle_accident" ADD CONSTRAINT "FK_83c35413f94f6c3a1c8c05ad4f1" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicle_accident" ADD CONSTRAINT "FK_99b58b33529b87aebd788f77686" FOREIGN KEY ("car_id") REFERENCES "car"("car_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicle_accident" ADD CONSTRAINT "FK_1e015d25e77f2e6f5174cb1036c" FOREIGN KEY ("employee_id") REFERENCES "employee"("employee_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicle_accident" ADD CONSTRAINT "FK_2000ad7aae034d1996f07d9efda" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tire" ADD CONSTRAINT "FK_4d9a885cbe45d32a05b0083b906" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tire" ADD CONSTRAINT "FK_1aacb8a04f755929167e6f8117d" FOREIGN KEY ("car_id") REFERENCES "car"("car_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tire_event" ADD CONSTRAINT "FK_0be6bc39d234517b95e758d916f" FOREIGN KEY ("tire_id") REFERENCES "tire"("tire_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tire_event" ADD CONSTRAINT "FK_c88fcd0fe7dc9f9228db77cfb6f" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tire_event" ADD CONSTRAINT "FK_7b5154eec31cbcbdb3b14456b21" FOREIGN KEY ("car_id") REFERENCES "car"("car_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tire_event" ADD CONSTRAINT "FK_d9e58b451d933032d487f8b08e5" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "fuel_load" ADD CONSTRAINT "FK_d083e0be3bb71d18990f4d76153" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "fuel_load" ADD CONSTRAINT "FK_76c156efd52997ef49bfd8a9b9f" FOREIGN KEY ("car_id") REFERENCES "car"("car_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "fuel_load" ADD CONSTRAINT "FK_ee48925b2fcea12a694e512681c" FOREIGN KEY ("employee_id") REFERENCES "employee"("employee_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "fuel_load" ADD CONSTRAINT "FK_a70b641640176492d8d0634b818" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "maintenance_plan" WHERE "document_kind" = 'hazmat_vehicle_permit'`,
    );
    await queryRunner.query(
      `ALTER TABLE "traffic_fine" DROP CONSTRAINT "FK_5d3ee796a650efff7dc859091cf"`,
    );
    await queryRunner.query(
      `ALTER TABLE "traffic_fine" DROP CONSTRAINT "FK_367a6b8c0709f0a75bb2102ed37"`,
    );
    await queryRunner.query(
      `ALTER TABLE "traffic_fine" DROP CONSTRAINT "FK_61447819bfe7d42839be95fb820"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicle_accident" DROP CONSTRAINT "FK_83c35413f94f6c3a1c8c05ad4f1"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicle_accident" DROP CONSTRAINT "FK_99b58b33529b87aebd788f77686"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicle_accident" DROP CONSTRAINT "FK_1e015d25e77f2e6f5174cb1036c"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicle_accident" DROP CONSTRAINT "FK_2000ad7aae034d1996f07d9efda"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tire" DROP CONSTRAINT "FK_4d9a885cbe45d32a05b0083b906"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tire" DROP CONSTRAINT "FK_1aacb8a04f755929167e6f8117d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tire_event" DROP CONSTRAINT "FK_0be6bc39d234517b95e758d916f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tire_event" DROP CONSTRAINT "FK_c88fcd0fe7dc9f9228db77cfb6f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tire_event" DROP CONSTRAINT "FK_7b5154eec31cbcbdb3b14456b21"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tire_event" DROP CONSTRAINT "FK_d9e58b451d933032d487f8b08e5"`,
    );
    await queryRunner.query(
      `ALTER TABLE "fuel_load" DROP CONSTRAINT "FK_d083e0be3bb71d18990f4d76153"`,
    );
    await queryRunner.query(
      `ALTER TABLE "fuel_load" DROP CONSTRAINT "FK_76c156efd52997ef49bfd8a9b9f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "fuel_load" DROP CONSTRAINT "FK_ee48925b2fcea12a694e512681c"`,
    );
    await queryRunner.query(
      `ALTER TABLE "fuel_load" DROP CONSTRAINT "FK_a70b641640176492d8d0634b818"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_traffic_fine_status_due"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_traffic_fine_car"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_traffic_fine_act"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_vehicle_accident_status"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_vehicle_accident_car"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_tire_posicion_ocupada"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_tire_serial"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_tire_event_tire"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_fuel_load_distributor_loaded_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_fuel_load_car_loaded_at"`,
    );
    await queryRunner.query(`DROP TABLE "traffic_fine"`);
    await queryRunner.query(`DROP TABLE "vehicle_accident"`);
    await queryRunner.query(`DROP TABLE "tire"`);
    await queryRunner.query(`DROP TABLE "tire_event"`);
    await queryRunner.query(`DROP TABLE "fuel_load"`);
    await queryRunner.query(`ALTER TABLE "car" DROP COLUMN "fuel_type"`);
    await queryRunner.query(
      `ALTER TABLE "car" DROP COLUMN "tank_capacity_liters"`,
    );
    // Si la documentación del personal amplió el tipo, la columna es de las dos
    // migraciones: se deja y la baja la hace la del personal.
    const valoresDelTipo = (await queryRunner.query(
      `SELECT unnest(enum_range(NULL::"public"."plan_document_kind_enum"))::text AS valor`,
    )) as { valor: string }[];
    const columnaPropia = valoresDelTipo.length === 3;
    if (columnaPropia) {
      await queryRunner.query(
        `ALTER TABLE "maintenance_plan" DROP COLUMN "document_kind"`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" DROP COLUMN "valid_from"`,
    );
    await queryRunner.query(`DROP TYPE "public"."traffic_fine_status_enum"`);
    await queryRunner.query(
      `DROP TYPE "public"."vehicle_accident_status_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."tire_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."tire_event_type_enum"`);
    await queryRunner.query(`DROP TYPE "public"."fuel_type_enum"`);
    await queryRunner.query(`DROP TYPE "public"."fuel_payment_method_enum"`);
    if (columnaPropia) {
      await queryRunner.query(`DROP TYPE "public"."plan_document_kind_enum"`);
    }
  }
}
