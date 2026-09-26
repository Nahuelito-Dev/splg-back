import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Las 17 tablas y 26 columnas "propuestas" del modelo de datos
 * (MODELO-DE-DOMINIO.md), tal como las especifica PROPUESTO en
 * splg-docs/generar-modelo-datos.py. user_address además cambia latitude y
 * longitude (varchar) por un punto PostGIS, convirtiendo los datos.
 */
export class ModeloPropuesto1790347058466 implements MigrationInterface {
  name = 'ModeloPropuesto1790347058466';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."route_batch_status_enum" AS ENUM('forming', 'offered', 'assigned', 'dissolved', 'completed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "route_batch" ("batch_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "status" "public"."route_batch_status_enum" NOT NULL DEFAULT 'forming', "total_weight_kg" numeric(10,2) NOT NULL, "delivery_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_0c6ffda2ea4ea9b9fce72b79e67" PRIMARY KEY ("batch_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_39b785b153c83c123bd9d19998" ON "route_batch" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "route_batch_stop" ("stop_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "batch_id" uuid NOT NULL, "order_id" uuid NOT NULL, "sequence" integer NOT NULL, CONSTRAINT "UQ_route_batch_stop_batch_order" UNIQUE ("batch_id", "order_id"), CONSTRAINT "PK_d9ba16fd7aeaeb044ce2a375886" PRIMARY KEY ("stop_id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."proposal_status_enum" AS ENUM('pending', 'accepted', 'rejected', 'expired')`,
    );
    await queryRunner.query(
      `CREATE TABLE "route_batch_offer" ("offer_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "batch_id" uuid NOT NULL, "delivery_id" uuid NOT NULL, "status" "public"."proposal_status_enum" NOT NULL DEFAULT 'pending', "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "responded_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_b7ec066a1beaa3fceff509de72d" PRIMARY KEY ("offer_id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "order_status_history" ("history_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "order_id" uuid NOT NULL, "from_status" "public"."order_status_enum", "to_status" "public"."order_status_enum" NOT NULL, "changed_by_user_id" uuid, "reason" text, "changed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_a4248a149d1835f67729d493bab" PRIMARY KEY ("history_id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "order_address_change" ("change_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "order_id" uuid NOT NULL, "from_address_id" uuid NOT NULL, "to_address_id" uuid NOT NULL, "changed_by_user_id" uuid NOT NULL, "changed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "reason" text, CONSTRAINT "PK_08efe70bd1c403b83bdec195f68" PRIMARY KEY ("change_id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "vehicle_usage_log" ("log_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "car_id" uuid NOT NULL, "distributor_id" uuid NOT NULL, "day" date NOT NULL, "km" numeric(10,2) NOT NULL, "orders" integer NOT NULL DEFAULT '0', "route_hours" numeric(6,2) NOT NULL DEFAULT '0', CONSTRAINT "UQ_vehicle_usage_log_car_day" UNIQUE ("car_id", "day"), CONSTRAINT "PK_53aa08b240936d6d339c9ef4fd9" PRIMARY KEY ("log_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_8d4be9c7008fc808b4900a83a5" ON "vehicle_usage_log" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."maintenance_subject_enum" AS ENUM('vehicle', 'driver')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."maintenance_trigger_enum" AS ENUM('by_km', 'by_time', 'by_fixed_date')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."maintenance_criticality_enum" AS ENUM('blocking', 'non_blocking')`,
    );
    await queryRunner.query(
      `CREATE TABLE "maintenance_plan" ("plan_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "name" character varying(120) NOT NULL, "subject" "public"."maintenance_subject_enum" NOT NULL, "trigger" "public"."maintenance_trigger_enum" NOT NULL, "interval_km" integer, "interval_months" integer, "lead_time_days" integer NOT NULL, "criticality" "public"."maintenance_criticality_enum" NOT NULL, "car_type" character varying, "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "PK_faeec4a9735696ac9d1c915b380" PRIMARY KEY ("plan_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_7ee5533ee6d3b24f7d74a2c61c" ON "maintenance_plan" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."maintenance_task_status_enum" AS ENUM('forecast', 'scheduled', 'in_progress', 'done', 'overdue', 'cancelled')`,
    );
    await queryRunner.query(
      `CREATE TABLE "maintenance_task" ("task_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "plan_id" uuid NOT NULL, "distributor_id" uuid NOT NULL, "car_id" uuid, "delivery_id" uuid, "status" "public"."maintenance_task_status_enum" NOT NULL DEFAULT 'forecast', "due_at" TIMESTAMP WITH TIME ZONE, "due_km" integer, "predicted_due_at" TIMESTAMP WITH TIME ZONE, "scheduled_at" TIMESTAMP WITH TIME ZONE, "performed_at" TIMESTAMP WITH TIME ZONE, "odometer_km" integer, "cost" numeric(10,2), "provider" character varying(120), "reference_number" character varying(60), "category" character varying(10), "alerted_at" TIMESTAMP WITH TIME ZONE, "notes" text, CONSTRAINT "PK_470104a71d4cef9fdebb18367bf" PRIMARY KEY ("task_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ec96001f6fe2869ae6b40f2dc8" ON "maintenance_task" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "maintenance_window_proposal" ("proposal_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "task_id" uuid NOT NULL, "delivery_id" uuid NOT NULL, "window_start" TIMESTAMP WITH TIME ZONE NOT NULL, "window_end" TIMESTAMP WITH TIME ZONE NOT NULL, "rank" integer NOT NULL, "status" "public"."proposal_status_enum" NOT NULL DEFAULT 'pending', "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "responded_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_93c5f2c747e191c299906a6afd1" PRIMARY KEY ("proposal_id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."configurable_process_enum" AS ENUM('fleet_planner', 'repurchase', 'route_batching', 'cylinder_recovery', 'express_dispatch')`,
    );
    await queryRunner.query(
      `CREATE TABLE "module_config" ("config_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "module" "public"."configurable_process_enum" NOT NULL, "params" jsonb NOT NULL, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_by_user_id" uuid, CONSTRAINT "UQ_module_config_distributor_module" UNIQUE ("distributor_id", "module"), CONSTRAINT "PK_dc79262c913215440d9bf442d65" PRIMARY KEY ("config_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ba2e1f43e70ba77c13d6844ee8" ON "module_config" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."recovery_case_status_enum" AS ENUM('open', 'returned', 'escalated', 'deposit_charged', 'written_off', 'closed_no_charge')`,
    );
    await queryRunner.query(
      `CREATE TABLE "cylinder_recovery_case" ("case_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "cylinder_id" uuid NOT NULL, "user_id" uuid NOT NULL, "delivered_at" TIMESTAMP WITH TIME ZONE NOT NULL, "deposit_amount" numeric(10,2) NOT NULL, "step" integer NOT NULL DEFAULT '1', "status" "public"."recovery_case_status_enum" NOT NULL DEFAULT 'open', "opened_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "closed_at" TIMESTAMP WITH TIME ZONE, "resolved_by_user_id" uuid, "resolution_note" text, CONSTRAINT "PK_57f617559d6ec3f36ff939b3f33" PRIMARY KEY ("case_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_d6bb53d55c3556b23295d5ac5a" ON "cylinder_recovery_case" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_32fe6a642ad74004e88561b07a" ON "cylinder_recovery_case" ("cylinder_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_77cd8b4b3c44851b932ca9c12d" ON "cylinder_recovery_case" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."recovery_notice_kind_enum" AS ENUM('reminder', 'pickup_offer', 'deposit_warning')`,
    );
    await queryRunner.query(
      `CREATE TABLE "cylinder_recovery_notice" ("notice_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "case_id" uuid NOT NULL, "step" integer NOT NULL, "kind" "public"."recovery_notice_kind_enum" NOT NULL, "status" "public"."proposal_status_enum", "sent_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_8bf6cdcdc12feb57a8514f5550d" PRIMARY KEY ("notice_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ea6566148b8616520f5a1a7f1a" ON "cylinder_recovery_notice" ("case_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."cylinder_inspection_result_enum" AS ENUM('approved', 'conditional', 'rejected')`,
    );
    await queryRunner.query(
      `CREATE TABLE "cylinder_inspection" ("inspection_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "cylinder_id" uuid NOT NULL, "distributor_id" uuid NOT NULL, "inspected_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "result" "public"."cylinder_inspection_result_enum" NOT NULL, "next_due_at" TIMESTAMP WITH TIME ZONE, "notes" text, CONSTRAINT "PK_ccd91038cdcafc7f43a46c9ca16" PRIMARY KEY ("inspection_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_531df2a7a7ab3fda4f1591e80d" ON "cylinder_inspection" ("cylinder_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_1cbfd2007890911e8b42d207d4" ON "cylinder_inspection" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."repurchase_invitation_status_enum" AS ENUM('pending', 'accepted', 'rejected', 'expired')`,
    );
    await queryRunner.query(
      `CREATE TABLE "repurchase_invitation" ("invitation_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "user_id" uuid NOT NULL, "address_id" uuid, "projected_depletion_at" TIMESTAMP WITH TIME ZONE NOT NULL, "suggested_items" jsonb NOT NULL, "status" "public"."repurchase_invitation_status_enum" NOT NULL DEFAULT 'pending', "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "responded_at" TIMESTAMP WITH TIME ZONE, "order_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_cf3829957696955e53d5f45a192" PRIMARY KEY ("invitation_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ec297644c2db0dab5171e00f1f" ON "repurchase_invitation" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_17f0b53699f596f5eb43c0374f" ON "repurchase_invitation" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "cart" ("cart_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "distributor_id" uuid NOT NULL, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_cart_user_distributor" UNIQUE ("user_id", "distributor_id"), CONSTRAINT "PK_c741cd2adcfb2f2d1c2743d76b6" PRIMARY KEY ("cart_id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "cart_item" ("cart_item_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "cart_id" uuid NOT NULL, "gas_cylinder_id" uuid NOT NULL, "quantity" integer NOT NULL, "unit_price" numeric(10,2) NOT NULL, CONSTRAINT "UQ_cart_item_cart_gascylinder" UNIQUE ("cart_id", "gas_cylinder_id"), CONSTRAINT "PK_a96f2f9a014485fe47477c26c4a" PRIMARY KEY ("cart_item_id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."audit_result_enum" AS ENUM('success', 'failure')`,
    );
    await queryRunner.query(
      `CREATE TABLE "audit_log" ("audit_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid, "actor_user_id" uuid, "actor_role" character varying(30), "http_method" character varying(10) NOT NULL, "resource" character varying(60) NOT NULL, "resource_id" character varying(64), "path" character varying(255) NOT NULL, "client_source" character varying(30), "ip" character varying(45), "result" "public"."audit_result_enum" NOT NULL, "status_code" integer NOT NULL, "changes" jsonb, "error_message" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_90d705dc65e834a7bfc79ea4df0" PRIMARY KEY ("audit_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_log_distributor" ON "audit_log" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_log_actor" ON "audit_log" ("actor_user_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_log_created_at" ON "audit_log" ("created_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "customer" ADD "avg_monthly_consumption_kg" numeric(10,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer" ADD "declared_cylinder_type_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer" ADD "repurchase_notice_days" integer DEFAULT '3'`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer" ADD "next_repurchase_estimate_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "car" ADD "tare_weight_kg" numeric(10,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "car" ADD "max_load_kg" numeric(10,2)`,
    );
    await queryRunner.query(`ALTER TABLE "car" ADD "odometer_km" integer`);
    await queryRunner.query(
      `CREATE TYPE "public"."fleet_status_enum" AS ENUM('active', 'in_service', 'grounded')`,
    );
    await queryRunner.query(
      `ALTER TABLE "car" ADD "fleet_status" "public"."fleet_status_enum" NOT NULL DEFAULT 'active'`,
    );
    await queryRunner.query(
      `ALTER TABLE "car" ADD "in_service_since" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_address" ADD "floor" character varying(10)`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_address" ADD "apartment" character varying(10)`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_address" ADD "location" geometry(Point,4326)`,
    );
    // Las coordenadas que eran dos varchar pasan al punto antes de borrarlas
    // (148 direcciones en la base de desarrollo, todas válidas).
    await queryRunner.query(
      `UPDATE "user_address"
          SET "location" = ST_SetSRID(ST_MakePoint(trim("longitude")::float8, trim("latitude")::float8), 4326)
        WHERE "latitude" ~ '^\\s*-?[0-9]+(\\.[0-9]+)?\\s*$' AND "longitude" ~ '^\\s*-?[0-9]+(\\.[0-9]+)?\\s*$'`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_address" DROP COLUMN "latitude"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_address" DROP COLUMN "longitude"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_address" ADD "place_id" character varying(255)`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."address_geocode_precision_enum" AS ENUM('exact', 'approximate', 'unresolved')`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_address" ADD "geocode_precision" "public"."address_geocode_precision_enum" NOT NULL DEFAULT 'unresolved'`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD "receiver_name" character varying(120)`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD "receiver_document" character varying(20)`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD "receiver_relationship" character varying(40)`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."order_delivery_mode_enum" AS ENUM('standard', 'express')`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" ADD "delivery_mode" "public"."order_delivery_mode_enum" NOT NULL DEFAULT 'standard'`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."incident_moment_enum" AS ENUM('pre_delivery', 'in_delivery', 'post_delivery')`,
    );
    await queryRunner.query(
      `ALTER TABLE "incident" ADD "moment" "public"."incident_moment_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder" ADD "manufactured_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder" ADD "last_inspection_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder" ADD "expires_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."coverage_zone_surcharge_type_enum" AS ENUM('fixed', 'percentage')`,
    );
    await queryRunner.query(
      `ALTER TABLE "coverage_zone" ADD "surcharge_type" "public"."coverage_zone_surcharge_type_enum" NOT NULL DEFAULT 'fixed'`,
    );
    await queryRunner.query(
      `ALTER TABLE "coverage_zone" ADD "label" character varying(40)`,
    );
    await queryRunner.query(
      `ALTER TABLE "coverage_zone" ADD "color" character varying(7)`,
    );
    await queryRunner.query(
      `ALTER TABLE "coverage_zone" ADD "valid_until" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ef8ba785cbfbb81849828b38e7" ON "user_address" USING GiST ("location") `,
    );
    await queryRunner.query(
      `ALTER TABLE "customer" ADD CONSTRAINT "FK_a2106c82437ec332b5088caf6b1" FOREIGN KEY ("declared_cylinder_type_id") REFERENCES "gas_cylinder"("gas_cylinder_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "FK_39b785b153c83c123bd9d19998b" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" ADD CONSTRAINT "FK_3d79cb7510a1e307205011172e1" FOREIGN KEY ("delivery_id") REFERENCES "delivery"("delivery_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD CONSTRAINT "FK_972a5539c274d0faff237b4bb9f" FOREIGN KEY ("batch_id") REFERENCES "route_batch"("batch_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" ADD CONSTRAINT "FK_7b0e52715d563cbd42bbba07611" FOREIGN KEY ("order_id") REFERENCES "order"("order_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_offer" ADD CONSTRAINT "FK_18e6affa6e02d38211d2c66bbc6" FOREIGN KEY ("batch_id") REFERENCES "route_batch"("batch_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_offer" ADD CONSTRAINT "FK_473c8590cc59607b872737c10e7" FOREIGN KEY ("delivery_id") REFERENCES "delivery"("delivery_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_status_history" ADD CONSTRAINT "FK_1ca7d5228cf9dc589b60243933c" FOREIGN KEY ("order_id") REFERENCES "order"("order_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_status_history" ADD CONSTRAINT "FK_965678b54f0a0361ca72c541b20" FOREIGN KEY ("changed_by_user_id") REFERENCES "user"("user_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_address_change" ADD CONSTRAINT "FK_4c82c1fe16612f55a925ec87741" FOREIGN KEY ("order_id") REFERENCES "order"("order_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_address_change" ADD CONSTRAINT "FK_4edcddc447d5f54977484558f13" FOREIGN KEY ("from_address_id") REFERENCES "user_address"("address_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_address_change" ADD CONSTRAINT "FK_0df2b04b370f3e43a31ba1bf92d" FOREIGN KEY ("to_address_id") REFERENCES "user_address"("address_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_address_change" ADD CONSTRAINT "FK_a8e249e6f7a18773fba8dba6abb" FOREIGN KEY ("changed_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicle_usage_log" ADD CONSTRAINT "FK_2eb120806e084673aa3ed255648" FOREIGN KEY ("car_id") REFERENCES "car"("car_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicle_usage_log" ADD CONSTRAINT "FK_8d4be9c7008fc808b4900a83a5d" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_plan" ADD CONSTRAINT "FK_7ee5533ee6d3b24f7d74a2c61ce" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" ADD CONSTRAINT "FK_296b62bd1680483d20f2652e62f" FOREIGN KEY ("plan_id") REFERENCES "maintenance_plan"("plan_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" ADD CONSTRAINT "FK_ec96001f6fe2869ae6b40f2dc8a" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" ADD CONSTRAINT "FK_953928a930bb8d120a8c3fe0a04" FOREIGN KEY ("car_id") REFERENCES "car"("car_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" ADD CONSTRAINT "FK_0c10df10892879498bf6037f951" FOREIGN KEY ("delivery_id") REFERENCES "delivery"("delivery_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" ADD CONSTRAINT "FK_199a2b630307c31e90bf0545c26" FOREIGN KEY ("task_id") REFERENCES "maintenance_task"("task_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" ADD CONSTRAINT "FK_24b20b6fcfe92abf85bc56c9072" FOREIGN KEY ("delivery_id") REFERENCES "delivery"("delivery_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "FK_ba2e1f43e70ba77c13d6844ee84" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" ADD CONSTRAINT "FK_e7a90d274237d2c001539efd653" FOREIGN KEY ("updated_by_user_id") REFERENCES "user"("user_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_case" ADD CONSTRAINT "FK_d6bb53d55c3556b23295d5ac5a2" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_case" ADD CONSTRAINT "FK_32fe6a642ad74004e88561b07aa" FOREIGN KEY ("cylinder_id") REFERENCES "cylinder"("cylinder_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_case" ADD CONSTRAINT "FK_77cd8b4b3c44851b932ca9c12df" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_case" ADD CONSTRAINT "FK_91d1e55b673db38c8f99d08f4d2" FOREIGN KEY ("resolved_by_user_id") REFERENCES "user"("user_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_notice" ADD CONSTRAINT "FK_ea6566148b8616520f5a1a7f1ad" FOREIGN KEY ("case_id") REFERENCES "cylinder_recovery_case"("case_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_inspection" ADD CONSTRAINT "FK_531df2a7a7ab3fda4f1591e80d6" FOREIGN KEY ("cylinder_id") REFERENCES "cylinder"("cylinder_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_inspection" ADD CONSTRAINT "FK_1cbfd2007890911e8b42d207d4b" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" ADD CONSTRAINT "FK_ec297644c2db0dab5171e00f1f1" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" ADD CONSTRAINT "FK_17f0b53699f596f5eb43c0374f4" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" ADD CONSTRAINT "FK_08d87c5a7e23297e7658f341f68" FOREIGN KEY ("address_id") REFERENCES "user_address"("address_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" ADD CONSTRAINT "FK_a1798ae7c0a36f272fa9ec34208" FOREIGN KEY ("order_id") REFERENCES "order"("order_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart" ADD CONSTRAINT "FK_f091e86a234693a49084b4c2c86" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart" ADD CONSTRAINT "FK_fe7495dc822eabf84bf1dc84e0f" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_item" ADD CONSTRAINT "FK_b6b2a4f1f533d89d218e70db941" FOREIGN KEY ("cart_id") REFERENCES "cart"("cart_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_item" ADD CONSTRAINT "FK_38a83baf23c61fcb6a28521e4cd" FOREIGN KEY ("gas_cylinder_id") REFERENCES "gas_cylinder"("gas_cylinder_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_log" ADD CONSTRAINT "FK_617015cb20b8887ecb699504a84" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_log" ADD CONSTRAINT "FK_1c4c8c76598008ea972a84e7834" FOREIGN KEY ("actor_user_id") REFERENCES "user"("user_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "audit_log" DROP CONSTRAINT "FK_1c4c8c76598008ea972a84e7834"`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_log" DROP CONSTRAINT "FK_617015cb20b8887ecb699504a84"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_item" DROP CONSTRAINT "FK_38a83baf23c61fcb6a28521e4cd"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart_item" DROP CONSTRAINT "FK_b6b2a4f1f533d89d218e70db941"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart" DROP CONSTRAINT "FK_fe7495dc822eabf84bf1dc84e0f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cart" DROP CONSTRAINT "FK_f091e86a234693a49084b4c2c86"`,
    );
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" DROP CONSTRAINT "FK_a1798ae7c0a36f272fa9ec34208"`,
    );
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" DROP CONSTRAINT "FK_08d87c5a7e23297e7658f341f68"`,
    );
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" DROP CONSTRAINT "FK_17f0b53699f596f5eb43c0374f4"`,
    );
    await queryRunner.query(
      `ALTER TABLE "repurchase_invitation" DROP CONSTRAINT "FK_ec297644c2db0dab5171e00f1f1"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_inspection" DROP CONSTRAINT "FK_1cbfd2007890911e8b42d207d4b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_inspection" DROP CONSTRAINT "FK_531df2a7a7ab3fda4f1591e80d6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_notice" DROP CONSTRAINT "FK_ea6566148b8616520f5a1a7f1ad"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_case" DROP CONSTRAINT "FK_91d1e55b673db38c8f99d08f4d2"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_case" DROP CONSTRAINT "FK_77cd8b4b3c44851b932ca9c12df"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_case" DROP CONSTRAINT "FK_32fe6a642ad74004e88561b07aa"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder_recovery_case" DROP CONSTRAINT "FK_d6bb53d55c3556b23295d5ac5a2"`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "FK_e7a90d274237d2c001539efd653"`,
    );
    await queryRunner.query(
      `ALTER TABLE "module_config" DROP CONSTRAINT "FK_ba2e1f43e70ba77c13d6844ee84"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" DROP CONSTRAINT "FK_24b20b6fcfe92abf85bc56c9072"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_window_proposal" DROP CONSTRAINT "FK_199a2b630307c31e90bf0545c26"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" DROP CONSTRAINT "FK_0c10df10892879498bf6037f951"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" DROP CONSTRAINT "FK_953928a930bb8d120a8c3fe0a04"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" DROP CONSTRAINT "FK_ec96001f6fe2869ae6b40f2dc8a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_task" DROP CONSTRAINT "FK_296b62bd1680483d20f2652e62f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_plan" DROP CONSTRAINT "FK_7ee5533ee6d3b24f7d74a2c61ce"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicle_usage_log" DROP CONSTRAINT "FK_8d4be9c7008fc808b4900a83a5d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vehicle_usage_log" DROP CONSTRAINT "FK_2eb120806e084673aa3ed255648"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_address_change" DROP CONSTRAINT "FK_a8e249e6f7a18773fba8dba6abb"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_address_change" DROP CONSTRAINT "FK_0df2b04b370f3e43a31ba1bf92d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_address_change" DROP CONSTRAINT "FK_4edcddc447d5f54977484558f13"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_address_change" DROP CONSTRAINT "FK_4c82c1fe16612f55a925ec87741"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_status_history" DROP CONSTRAINT "FK_965678b54f0a0361ca72c541b20"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_status_history" DROP CONSTRAINT "FK_1ca7d5228cf9dc589b60243933c"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_offer" DROP CONSTRAINT "FK_473c8590cc59607b872737c10e7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_offer" DROP CONSTRAINT "FK_18e6affa6e02d38211d2c66bbc6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" DROP CONSTRAINT "FK_7b0e52715d563cbd42bbba07611"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch_stop" DROP CONSTRAINT "FK_972a5539c274d0faff237b4bb9f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "FK_3d79cb7510a1e307205011172e1"`,
    );
    await queryRunner.query(
      `ALTER TABLE "route_batch" DROP CONSTRAINT "FK_39b785b153c83c123bd9d19998b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer" DROP CONSTRAINT "FK_a2106c82437ec332b5088caf6b1"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_ef8ba785cbfbb81849828b38e7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "coverage_zone" DROP COLUMN "valid_until"`,
    );
    await queryRunner.query(`ALTER TABLE "coverage_zone" DROP COLUMN "color"`);
    await queryRunner.query(`ALTER TABLE "coverage_zone" DROP COLUMN "label"`);
    await queryRunner.query(
      `ALTER TABLE "coverage_zone" DROP COLUMN "surcharge_type"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."coverage_zone_surcharge_type_enum"`,
    );
    await queryRunner.query(`ALTER TABLE "cylinder" DROP COLUMN "expires_at"`);
    await queryRunner.query(
      `ALTER TABLE "cylinder" DROP COLUMN "last_inspection_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cylinder" DROP COLUMN "manufactured_at"`,
    );
    await queryRunner.query(`ALTER TABLE "incident" DROP COLUMN "moment"`);
    await queryRunner.query(`DROP TYPE "public"."incident_moment_enum"`);
    await queryRunner.query(`ALTER TABLE "order" DROP COLUMN "delivery_mode"`);
    await queryRunner.query(`DROP TYPE "public"."order_delivery_mode_enum"`);
    await queryRunner.query(
      `ALTER TABLE "order" DROP COLUMN "receiver_relationship"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order" DROP COLUMN "receiver_document"`,
    );
    await queryRunner.query(`ALTER TABLE "order" DROP COLUMN "receiver_name"`);
    await queryRunner.query(
      `ALTER TABLE "user_address" DROP COLUMN "geocode_precision"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."address_geocode_precision_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_address" DROP COLUMN "place_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_address" ADD "latitude" character varying(50)`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_address" ADD "longitude" character varying(50)`,
    );
    await queryRunner.query(
      `UPDATE "user_address" SET "latitude" = ST_Y("location")::text, "longitude" = ST_X("location")::text WHERE "location" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_address" DROP COLUMN "location"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_address" DROP COLUMN "apartment"`,
    );
    await queryRunner.query(`ALTER TABLE "user_address" DROP COLUMN "floor"`);
    await queryRunner.query(`ALTER TABLE "car" DROP COLUMN "in_service_since"`);
    await queryRunner.query(`ALTER TABLE "car" DROP COLUMN "fleet_status"`);
    await queryRunner.query(`DROP TYPE "public"."fleet_status_enum"`);
    await queryRunner.query(`ALTER TABLE "car" DROP COLUMN "odometer_km"`);
    await queryRunner.query(`ALTER TABLE "car" DROP COLUMN "max_load_kg"`);
    await queryRunner.query(`ALTER TABLE "car" DROP COLUMN "tare_weight_kg"`);
    await queryRunner.query(
      `ALTER TABLE "customer" DROP COLUMN "next_repurchase_estimate_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer" DROP COLUMN "repurchase_notice_days"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer" DROP COLUMN "declared_cylinder_type_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer" DROP COLUMN "avg_monthly_consumption_kg"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_audit_log_created_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_audit_log_actor"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_audit_log_distributor"`);
    await queryRunner.query(`DROP TABLE "audit_log"`);
    await queryRunner.query(`DROP TYPE "public"."audit_result_enum"`);
    await queryRunner.query(`DROP TABLE "cart_item"`);
    await queryRunner.query(`DROP TABLE "cart"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_17f0b53699f596f5eb43c0374f"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_ec297644c2db0dab5171e00f1f"`,
    );
    await queryRunner.query(`DROP TABLE "repurchase_invitation"`);
    await queryRunner.query(
      `DROP TYPE "public"."repurchase_invitation_status_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_1cbfd2007890911e8b42d207d4"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_531df2a7a7ab3fda4f1591e80d"`,
    );
    await queryRunner.query(`DROP TABLE "cylinder_inspection"`);
    await queryRunner.query(
      `DROP TYPE "public"."cylinder_inspection_result_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_ea6566148b8616520f5a1a7f1a"`,
    );
    await queryRunner.query(`DROP TABLE "cylinder_recovery_notice"`);
    await queryRunner.query(`DROP TYPE "public"."recovery_notice_kind_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_77cd8b4b3c44851b932ca9c12d"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_32fe6a642ad74004e88561b07a"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_d6bb53d55c3556b23295d5ac5a"`,
    );
    await queryRunner.query(`DROP TABLE "cylinder_recovery_case"`);
    await queryRunner.query(`DROP TYPE "public"."recovery_case_status_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_ba2e1f43e70ba77c13d6844ee8"`,
    );
    await queryRunner.query(`DROP TABLE "module_config"`);
    await queryRunner.query(`DROP TYPE "public"."configurable_process_enum"`);
    await queryRunner.query(`DROP TABLE "maintenance_window_proposal"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_ec96001f6fe2869ae6b40f2dc8"`,
    );
    await queryRunner.query(`DROP TABLE "maintenance_task"`);
    await queryRunner.query(
      `DROP TYPE "public"."maintenance_task_status_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_7ee5533ee6d3b24f7d74a2c61c"`,
    );
    await queryRunner.query(`DROP TABLE "maintenance_plan"`);
    await queryRunner.query(
      `DROP TYPE "public"."maintenance_criticality_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."maintenance_trigger_enum"`);
    await queryRunner.query(`DROP TYPE "public"."maintenance_subject_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_8d4be9c7008fc808b4900a83a5"`,
    );
    await queryRunner.query(`DROP TABLE "vehicle_usage_log"`);
    await queryRunner.query(`DROP TABLE "order_address_change"`);
    await queryRunner.query(`DROP TABLE "order_status_history"`);
    await queryRunner.query(`DROP TABLE "route_batch_offer"`);
    await queryRunner.query(`DROP TYPE "public"."proposal_status_enum"`);
    await queryRunner.query(`DROP TABLE "route_batch_stop"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_39b785b153c83c123bd9d19998"`,
    );
    await queryRunner.query(`DROP TABLE "route_batch"`);
    await queryRunner.query(`DROP TYPE "public"."route_batch_status_enum"`);
  }
}
