import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Caja y rendición (M-D): cajas con sesión y arqueo, categorías, libro de
 * movimientos; rendición diaria del chofer; cuentas corrientes de clientes con
 * su libro e imputaciones; reglas de comisión, libro de comisiones y
 * liquidaciones.
 *
 * Además de las tablas:
 * - un disparador deja de solo agregar los tres libros (`cash_movement`,
 *   `customer_account_entry`, `commission_entry`); en el de comisiones sólo se
 *   puede asignar o liberar la liquidación;
 * - siembra la "Caja central" y las diez categorías de sistema en cada
 *   distribuidora que ya existe.
 */
export class CajaYRendicion1792400100000 implements MigrationInterface {
  name = 'CajaYRendicion1792400100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."cash_box_kind_enum" AS ENUM('cash', 'bank', 'wallet')`,
    );
    await queryRunner.query(
      `CREATE TABLE "cash_box" ("cash_box_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "name" character varying(80) NOT NULL, "kind" "public"."cash_box_kind_enum" NOT NULL, "balance" numeric(14,2) NOT NULL DEFAULT '0', "requires_session" boolean NOT NULL DEFAULT false, "is_active" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "CHK_cash_box_efectivo_no_negativo" CHECK ("kind" <> 'cash' OR "balance" >= 0), CONSTRAINT "PK_d48c98d81a07966df57824713cd" PRIMARY KEY ("cash_box_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cash_box_distributor" ON "cash_box" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_cash_box_nombre_vigente" ON "cash_box" ("distributor_id", "name") WHERE "deletedAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."cash_category_direction_enum" AS ENUM('income', 'expense')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."cash_category_system_code_enum" AS ENUM('driver_settlement', 'customer_payment', 'commission_payment', 'cash_surplus', 'cash_shortage', 'transfer_in', 'transfer_out', 'purchase', 'fuel', 'traffic_fine')`,
    );
    await queryRunner.query(
      `CREATE TABLE "cash_category" ("category_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "name" character varying(80) NOT NULL, "direction" "public"."cash_category_direction_enum" NOT NULL, "system_code" "public"."cash_category_system_code_enum", "is_active" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_9ed23398638cf60f931c58a6254" PRIMARY KEY ("category_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cash_category_distributor" ON "cash_category" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_cash_category_nombre_activa" ON "cash_category" ("distributor_id", "direction", "name") WHERE "is_active" = true AND "system_code" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_cash_category_sistema" ON "cash_category" ("distributor_id", "system_code") WHERE "system_code" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."cash_session_status_enum" AS ENUM('open', 'closed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "cash_session" ("session_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "cash_box_id" uuid NOT NULL, "status" "public"."cash_session_status_enum" NOT NULL DEFAULT 'open', "opened_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "opened_by_user_id" uuid NOT NULL, "opening_amount" numeric(14,2) NOT NULL, "closed_at" TIMESTAMP WITH TIME ZONE, "closed_by_user_id" uuid, "expected_amount" numeric(14,2), "counted_amount" numeric(14,2), "difference" numeric(14,2), "notes" text, CONSTRAINT "PK_0405f0f75e0ea603b67f56512a0" PRIMARY KEY ("session_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cash_session_distributor" ON "cash_session" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cash_session_caja_fecha" ON "cash_session" ("cash_box_id", "opened_at") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_cash_session_abierta" ON "cash_session" ("cash_box_id") WHERE "status" = 'open'`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."cash_movement_direction_enum" AS ENUM('in', 'out')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."cash_movement_method_enum" AS ENUM('cash', 'transfer', 'card', 'mercadopago', 'check')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."cash_movement_reference_type_enum" AS ENUM('manual', 'session_opening', 'session_closing', 'driver_settlement', 'customer_payment', 'purchase_receipt', 'fuel_load', 'traffic_fine', 'driver_liquidation', 'box_transfer', 'reversal')`,
    );
    await queryRunner.query(
      `CREATE TABLE "cash_movement" ("movement_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "cash_box_id" uuid NOT NULL, "session_id" uuid, "direction" "public"."cash_movement_direction_enum" NOT NULL, "amount" numeric(12,2) NOT NULL, "category_id" uuid NOT NULL, "method" "public"."cash_movement_method_enum" NOT NULL DEFAULT 'cash', "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "description" character varying(255) NOT NULL, "reference_type" "public"."cash_movement_reference_type_enum" NOT NULL DEFAULT 'manual', "reference_id" uuid, "reverses_movement_id" uuid, "created_by_user_id" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_cash_movement_importe" CHECK ("amount" > 0), CONSTRAINT "PK_c3fc21001d0a2ada9461504eeb8" PRIMARY KEY ("movement_id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_cash_movement_anula" ON "cash_movement" ("reverses_movement_id") WHERE "reverses_movement_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cash_movement_sesion" ON "cash_movement" ("session_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cash_movement_referencia" ON "cash_movement" ("reference_type", "reference_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cash_movement_distribuidora_fecha" ON "cash_movement" ("distributor_id", "occurred_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cash_movement_caja_fecha" ON "cash_movement" ("cash_box_id", "occurred_at") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."customer_account_tax_condition_enum" AS ENUM('registered', 'monotax', 'exempt', 'final_consumer')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."customer_account_status_enum" AS ENUM('active', 'blocked', 'closed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "customer_account" ("account_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "customer_user_id" uuid NOT NULL, "business_name" character varying(120) NOT NULL, "tax_id" character varying(11), "tax_condition" "public"."customer_account_tax_condition_enum" NOT NULL, "credit_limit" numeric(12,2) NOT NULL DEFAULT '0', "payment_terms_days" integer NOT NULL DEFAULT '30', "status" "public"."customer_account_status_enum" NOT NULL DEFAULT 'active', "balance" numeric(14,2) NOT NULL DEFAULT '0', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "CHK_customer_account_plazo" CHECK ("payment_terms_days" > 0), CONSTRAINT "CHK_customer_account_limite" CHECK ("credit_limit" >= 0), CONSTRAINT "PK_d1e5a9401cb7dcb5604168f96ea" PRIMARY KEY ("account_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_customer_account_distributor" ON "customer_account" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_customer_account_cliente_vigente" ON "customer_account" ("distributor_id", "customer_user_id") WHERE "deletedAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."customer_account_entry_type_enum" AS ENUM('sale_charge', 'payment', 'credit_note', 'debit_note')`,
    );
    await queryRunner.query(
      `CREATE TABLE "customer_account_entry" ("entry_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "account_id" uuid NOT NULL, "type" "public"."customer_account_entry_type_enum" NOT NULL, "amount" numeric(12,2) NOT NULL, "order_id" uuid, "due_date" date, "payment_method" character varying(20), "cash_movement_id" uuid, "collected_by_delivery_id" uuid, "description" character varying(255), "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by_user_id" uuid, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_customer_account_entry_importe" CHECK ("amount" > 0), CONSTRAINT "PK_e1c743cf21d5ab0b30d342404dc" PRIMARY KEY ("entry_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_customer_account_entry_distributor" ON "customer_account_entry" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_customer_account_entry_cargo_pedido" ON "customer_account_entry" ("order_id") WHERE "type" = 'sale_charge'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_customer_account_entry_cuenta_fecha" ON "customer_account_entry" ("account_id", "occurred_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "driver_settlement_collection" ("collection_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "settlement_id" uuid NOT NULL, "entry_id" uuid NOT NULL, "amount" numeric(12,2) NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_9fb2ab779fdce604bd99c6e03d4" PRIMARY KEY ("collection_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_driver_settlement_collection_rendicion" ON "driver_settlement_collection" ("settlement_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_driver_settlement_collection_asiento" ON "driver_settlement_collection" ("entry_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "driver_settlement_expense" ("expense_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "settlement_id" uuid NOT NULL, "category_id" uuid NOT NULL, "amount" numeric(12,2) NOT NULL, "description" character varying(255), CONSTRAINT "CHK_driver_settlement_expense_importe" CHECK ("amount" > 0), CONSTRAINT "PK_08eefdada00e317b45b6010c36e" PRIMARY KEY ("expense_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_driver_settlement_expense_rendicion" ON "driver_settlement_expense" ("settlement_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."driver_settlement_status_enum" AS ENUM('open', 'submitted', 'approved')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."driver_settlement_difference_resolution_enum" AS ENUM('none', 'charged_to_driver', 'absorbed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "driver_settlement" ("settlement_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "delivery_id" uuid NOT NULL, "number" integer NOT NULL, "truck_load_id" uuid, "business_date" date NOT NULL, "status" "public"."driver_settlement_status_enum" NOT NULL DEFAULT 'open', "expected_cash" numeric(12,2) NOT NULL DEFAULT '0', "declared_cash" numeric(12,2), "driver_expenses" numeric(12,2) NOT NULL DEFAULT '0', "difference" numeric(12,2), "difference_resolution" "public"."driver_settlement_difference_resolution_enum", "destination_cash_box_id" uuid, "cash_movement_id" uuid, "submitted_at" TIMESTAMP WITH TIME ZONE, "submitted_by_user_id" uuid, "approved_at" TIMESTAMP WITH TIME ZONE, "approved_by_user_id" uuid, "notes" text, "overdue_alerted_at" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_6fac21943a903481ccf2fbc72e3" PRIMARY KEY ("settlement_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_driver_settlement_chofer" ON "driver_settlement" ("delivery_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_driver_settlement_estado" ON "driver_settlement" ("distributor_id", "status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_driver_settlement_fecha" ON "driver_settlement" ("distributor_id", "business_date") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_driver_settlement_carga" ON "driver_settlement" ("truck_load_id") WHERE "truck_load_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_driver_settlement_chofer_dia" ON "driver_settlement" ("delivery_id", "business_date") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_driver_settlement_numero" ON "driver_settlement" ("distributor_id", "number") `,
    );
    await queryRunner.query(
      `CREATE TABLE "driver_settlement_order" ("settlement_order_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "settlement_id" uuid NOT NULL, "order_id" uuid NOT NULL, "amount" numeric(12,2) NOT NULL, "payment_method" character varying(20) NOT NULL, CONSTRAINT "PK_32d328e79201459a738eb2f2071" PRIMARY KEY ("settlement_order_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_driver_settlement_order_rendicion" ON "driver_settlement_order" ("settlement_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_driver_settlement_order_pedido" ON "driver_settlement_order" ("order_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "customer_account_allocation" ("allocation_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "account_id" uuid NOT NULL, "debit_entry_id" uuid NOT NULL, "credit_entry_id" uuid NOT NULL, "amount" numeric(12,2) NOT NULL, CONSTRAINT "CHK_customer_account_allocation_importe" CHECK ("amount" > 0), CONSTRAINT "PK_656ecedc3cc77c138bd4f5ed181" PRIMARY KEY ("allocation_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_customer_account_allocation_cuenta" ON "customer_account_allocation" ("account_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_customer_account_allocation_debito" ON "customer_account_allocation" ("debit_entry_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_customer_account_allocation_credito" ON "customer_account_allocation" ("credit_entry_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."commission_rule_basis_enum" AS ENUM('per_unit', 'per_order', 'percent_of_total')`,
    );
    await queryRunner.query(
      `CREATE TABLE "commission_rule" ("rule_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "employee_id" uuid, "gas_cylinder_id" uuid, "basis" "public"."commission_rule_basis_enum" NOT NULL, "value" numeric(10,4) NOT NULL, "valid_from" date NOT NULL, "valid_to" date, "is_active" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_commission_rule_vigencia" CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from"), CONSTRAINT "CHK_commission_rule_valor" CHECK ("value" >= 0), CONSTRAINT "PK_e46763ead31c4f2fceeb5faefdd" PRIMARY KEY ("rule_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_commission_rule_distribuidora" ON "commission_rule" ("distributor_id", "is_active") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."driver_liquidation_status_enum" AS ENUM('draft', 'approved', 'paid', 'voided')`,
    );
    await queryRunner.query(
      `CREATE TABLE "driver_liquidation" ("liquidation_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "number" integer NOT NULL, "employee_id" uuid NOT NULL, "period_from" date NOT NULL, "period_to" date NOT NULL, "gross" numeric(12,2) NOT NULL, "deductions" numeric(12,2) NOT NULL, "net" numeric(12,2) NOT NULL, "status" "public"."driver_liquidation_status_enum" NOT NULL DEFAULT 'draft', "approved_at" TIMESTAMP WITH TIME ZONE, "approved_by_user_id" uuid, "paid_at" TIMESTAMP WITH TIME ZONE, "paid_by_user_id" uuid, "voided_at" TIMESTAMP WITH TIME ZONE, "cash_movement_id" uuid, "created_by_user_id" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_efb13a8e9ee929dd7477906021c" PRIMARY KEY ("liquidation_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_driver_liquidation_distributor" ON "driver_liquidation" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_driver_liquidation_empleado" ON "driver_liquidation" ("employee_id", "status") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_driver_liquidation_numero" ON "driver_liquidation" ("distributor_id", "number") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."commission_entry_type_enum" AS ENUM('delivery_commission', 'settlement_shortage', 'traffic_fine', 'adjustment', 'legacy_balance')`,
    );
    await queryRunner.query(
      `CREATE TABLE "commission_entry" ("entry_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "employee_id" uuid NOT NULL, "delivery_id" uuid, "type" "public"."commission_entry_type_enum" NOT NULL, "amount" numeric(12,2) NOT NULL, "order_id" uuid, "rule_id" uuid, "rule_snapshot" jsonb, "liquidation_id" uuid, "reference_id" uuid, "description" character varying(255) NOT NULL, "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "created_by_user_id" uuid, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_af74ef71d43b41c3a39141fda1c" PRIMARY KEY ("entry_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_commission_entry_distributor" ON "commission_entry" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_commission_entry_faltante" ON "commission_entry" ("reference_id") WHERE "type" = 'settlement_shortage'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_commission_entry_pedido" ON "commission_entry" ("order_id") WHERE "type" = 'delivery_commission'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_commission_entry_liquidacion" ON "commission_entry" ("liquidation_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_commission_entry_empleado" ON "commission_entry" ("employee_id", "occurred_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_box" ADD CONSTRAINT "FK_cf2a6266f8dc0f2d942fe88aa6e" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_category" ADD CONSTRAINT "FK_1528db3a4ea037a767795b0d9c9" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_session" ADD CONSTRAINT "FK_cba986fb1ad57b98770e517d9b8" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_session" ADD CONSTRAINT "FK_566ccda1abee03369e83fbdac52" FOREIGN KEY ("cash_box_id") REFERENCES "cash_box"("cash_box_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_session" ADD CONSTRAINT "FK_24c1c29632e21025336adc2d2c1" FOREIGN KEY ("opened_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_session" ADD CONSTRAINT "FK_8fd04897962bec0681603f29421" FOREIGN KEY ("closed_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_movement" ADD CONSTRAINT "FK_309ab225b94de04ab0ee244d6a9" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_movement" ADD CONSTRAINT "FK_a9b982c8aec7c799a146f449e25" FOREIGN KEY ("cash_box_id") REFERENCES "cash_box"("cash_box_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_movement" ADD CONSTRAINT "FK_d704d3ac4a86b13e238da3d4083" FOREIGN KEY ("session_id") REFERENCES "cash_session"("session_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_movement" ADD CONSTRAINT "FK_b1f34c53c367143701b9164785e" FOREIGN KEY ("category_id") REFERENCES "cash_category"("category_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_movement" ADD CONSTRAINT "FK_8e5c5ff29d543ee1e3a3d26a4a7" FOREIGN KEY ("reverses_movement_id") REFERENCES "cash_movement"("movement_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_movement" ADD CONSTRAINT "FK_b4ddcca770fe0f7b5b7c8131d25" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_account" ADD CONSTRAINT "FK_564bc79a7c5208b8a2e451f33ee" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_account" ADD CONSTRAINT "FK_05d48d2b9438d97c70797088f72" FOREIGN KEY ("customer_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_account_entry" ADD CONSTRAINT "FK_d9a03fad3dae8ac9c53de957b96" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_account_entry" ADD CONSTRAINT "FK_3f917672bdb3f9fa953b197a1d6" FOREIGN KEY ("account_id") REFERENCES "customer_account"("account_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_account_entry" ADD CONSTRAINT "FK_24670e6df94198c58ad163ecce4" FOREIGN KEY ("order_id") REFERENCES "order"("order_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_account_entry" ADD CONSTRAINT "FK_39f5f1bf029ec0921d6c9d81795" FOREIGN KEY ("cash_movement_id") REFERENCES "cash_movement"("movement_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_account_entry" ADD CONSTRAINT "FK_1401ec5da7e64330b406b3fbfa9" FOREIGN KEY ("collected_by_delivery_id") REFERENCES "delivery"("delivery_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_account_entry" ADD CONSTRAINT "FK_461301da4afa2be775baa570c22" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement_collection" ADD CONSTRAINT "FK_ffffe9c244ec6bc721223a622a6" FOREIGN KEY ("settlement_id") REFERENCES "driver_settlement"("settlement_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement_collection" ADD CONSTRAINT "FK_5a1110f63b59aadf68c65085ee0" FOREIGN KEY ("entry_id") REFERENCES "customer_account_entry"("entry_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement_expense" ADD CONSTRAINT "FK_81dfc131cc2b6c5d5aa5b4a854f" FOREIGN KEY ("settlement_id") REFERENCES "driver_settlement"("settlement_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement_expense" ADD CONSTRAINT "FK_e1279555100a50a59f7d6225db7" FOREIGN KEY ("category_id") REFERENCES "cash_category"("category_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement" ADD CONSTRAINT "FK_034a404a6b3c046410baaccd6bf" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement" ADD CONSTRAINT "FK_841e7f13d74799b8be10aab1fbf" FOREIGN KEY ("delivery_id") REFERENCES "delivery"("delivery_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement" ADD CONSTRAINT "FK_1751ff46c2e373bb36f760c3607" FOREIGN KEY ("truck_load_id") REFERENCES "truck_load"("load_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement" ADD CONSTRAINT "FK_4e7b4890ff3e759f07c7c215501" FOREIGN KEY ("destination_cash_box_id") REFERENCES "cash_box"("cash_box_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement" ADD CONSTRAINT "FK_75d32540838e7084b7c0eb113e0" FOREIGN KEY ("cash_movement_id") REFERENCES "cash_movement"("movement_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement" ADD CONSTRAINT "FK_dce1f0f1e826575bf49d6a5776f" FOREIGN KEY ("submitted_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement" ADD CONSTRAINT "FK_353df4e2e3c3e8ffca5e83f1ede" FOREIGN KEY ("approved_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement_order" ADD CONSTRAINT "FK_00b78dc2e95eff06336c982de3c" FOREIGN KEY ("settlement_id") REFERENCES "driver_settlement"("settlement_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement_order" ADD CONSTRAINT "FK_1022fc8018671046aefdab2f8fd" FOREIGN KEY ("order_id") REFERENCES "order"("order_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_account_allocation" ADD CONSTRAINT "FK_61ea8a58fa0af69e8d60b92da68" FOREIGN KEY ("account_id") REFERENCES "customer_account"("account_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_account_allocation" ADD CONSTRAINT "FK_040f1307a22c0877436239c49ea" FOREIGN KEY ("debit_entry_id") REFERENCES "customer_account_entry"("entry_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_account_allocation" ADD CONSTRAINT "FK_15d961bae7cbf44cda5649a10a6" FOREIGN KEY ("credit_entry_id") REFERENCES "customer_account_entry"("entry_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "commission_rule" ADD CONSTRAINT "FK_93f6151205640d2f5a157024b35" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "commission_rule" ADD CONSTRAINT "FK_7b250de6da53a02d3a91d255a68" FOREIGN KEY ("employee_id") REFERENCES "employee"("employee_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "commission_rule" ADD CONSTRAINT "FK_8c9d53a2fe9227838bf1790976a" FOREIGN KEY ("gas_cylinder_id") REFERENCES "gas_cylinder"("gas_cylinder_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_liquidation" ADD CONSTRAINT "FK_5ed664156f365d251740f9643f6" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_liquidation" ADD CONSTRAINT "FK_f87255c83855b6e635e95862da8" FOREIGN KEY ("employee_id") REFERENCES "employee"("employee_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_liquidation" ADD CONSTRAINT "FK_74adb440c22c7f7036811c76599" FOREIGN KEY ("approved_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_liquidation" ADD CONSTRAINT "FK_573612e2fab26969026ec1af128" FOREIGN KEY ("paid_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_liquidation" ADD CONSTRAINT "FK_f897f43191611d24ac38cb9f3da" FOREIGN KEY ("cash_movement_id") REFERENCES "cash_movement"("movement_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_liquidation" ADD CONSTRAINT "FK_0c2c60d341a621185c48d35e975" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "commission_entry" ADD CONSTRAINT "FK_a0c3335a8b5af840c818b5334a0" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "commission_entry" ADD CONSTRAINT "FK_b7d839b89e77ecff89abda761e5" FOREIGN KEY ("employee_id") REFERENCES "employee"("employee_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "commission_entry" ADD CONSTRAINT "FK_3c627d2c84dbd71130d917eb276" FOREIGN KEY ("delivery_id") REFERENCES "delivery"("delivery_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "commission_entry" ADD CONSTRAINT "FK_0b03f8315648bdfda67d1f3f4fa" FOREIGN KEY ("order_id") REFERENCES "order"("order_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "commission_entry" ADD CONSTRAINT "FK_3cdb19a54a48a911ecedbc38841" FOREIGN KEY ("rule_id") REFERENCES "commission_rule"("rule_id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "commission_entry" ADD CONSTRAINT "FK_feba91de77750347b3623fcf849" FOREIGN KEY ("liquidation_id") REFERENCES "driver_liquidation"("liquidation_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "commission_entry" ADD CONSTRAINT "FK_a53df91c9e50ec2b0ebd364ad9a" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(`
      CREATE FUNCTION libro_de_solo_agregar() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
          RETURN OLD;
        END IF;
        IF TG_TABLE_NAME = 'commission_entry' AND TG_OP = 'UPDATE'
           AND (to_jsonb(NEW) - 'liquidation_id') = (to_jsonb(OLD) - 'liquidation_id') THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION '% es un libro de sólo agregar: no se modifican ni se borran asientos', TG_TABLE_NAME;
      END;
      $$ LANGUAGE plpgsql
    `);
    for (const tabla of [
      'cash_movement',
      'customer_account_entry',
      'commission_entry',
    ]) {
      await queryRunner.query(
        `CREATE TRIGGER ${tabla}_solo_agregar BEFORE UPDATE OR DELETE ON "${tabla}" FOR EACH ROW EXECUTE FUNCTION libro_de_solo_agregar()`,
      );
    }
    await queryRunner.query(`
      INSERT INTO "cash_box" ("distributor_id", "name", "kind", "requires_session")
      SELECT d."distributor_id", 'Caja central', 'cash', true
      FROM "distributor" d
    `);
    await queryRunner.query(`
      INSERT INTO "cash_category" ("distributor_id", "name", "direction", "system_code")
      SELECT d."distributor_id", c."name", c."direction"::"public"."cash_category_direction_enum", c."code"::"public"."cash_category_system_code_enum"
      FROM "distributor" d
      CROSS JOIN (VALUES
          ('Rendición de chofer', 'income', 'driver_settlement'),
          ('Cobro de cuenta corriente', 'income', 'customer_payment'),
          ('Pago de comisiones', 'expense', 'commission_payment'),
          ('Sobrante de caja', 'income', 'cash_surplus'),
          ('Faltante de caja', 'expense', 'cash_shortage'),
          ('Transferencia entre cajas (entrada)', 'income', 'transfer_in'),
          ('Transferencia entre cajas (salida)', 'expense', 'transfer_out'),
          ('Compra de mercadería', 'expense', 'purchase'),
          ('Combustible', 'expense', 'fuel'),
          ('Multa de tránsito', 'expense', 'traffic_fine')
      ) AS c("name", "direction", "code")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const tabla of [
      'commission_entry',
      'customer_account_entry',
      'cash_movement',
    ]) {
      await queryRunner.query(
        `DROP TRIGGER IF EXISTS ${tabla}_solo_agregar ON "${tabla}"`,
      );
    }
    await queryRunner.query(`DROP FUNCTION IF EXISTS libro_de_solo_agregar()`);
    await queryRunner.query(
      `ALTER TABLE "commission_entry" DROP CONSTRAINT "FK_a53df91c9e50ec2b0ebd364ad9a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "commission_entry" DROP CONSTRAINT "FK_feba91de77750347b3623fcf849"`,
    );
    await queryRunner.query(
      `ALTER TABLE "commission_entry" DROP CONSTRAINT "FK_3cdb19a54a48a911ecedbc38841"`,
    );
    await queryRunner.query(
      `ALTER TABLE "commission_entry" DROP CONSTRAINT "FK_0b03f8315648bdfda67d1f3f4fa"`,
    );
    await queryRunner.query(
      `ALTER TABLE "commission_entry" DROP CONSTRAINT "FK_3c627d2c84dbd71130d917eb276"`,
    );
    await queryRunner.query(
      `ALTER TABLE "commission_entry" DROP CONSTRAINT "FK_b7d839b89e77ecff89abda761e5"`,
    );
    await queryRunner.query(
      `ALTER TABLE "commission_entry" DROP CONSTRAINT "FK_a0c3335a8b5af840c818b5334a0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_liquidation" DROP CONSTRAINT "FK_0c2c60d341a621185c48d35e975"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_liquidation" DROP CONSTRAINT "FK_f897f43191611d24ac38cb9f3da"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_liquidation" DROP CONSTRAINT "FK_573612e2fab26969026ec1af128"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_liquidation" DROP CONSTRAINT "FK_74adb440c22c7f7036811c76599"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_liquidation" DROP CONSTRAINT "FK_f87255c83855b6e635e95862da8"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_liquidation" DROP CONSTRAINT "FK_5ed664156f365d251740f9643f6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "commission_rule" DROP CONSTRAINT "FK_8c9d53a2fe9227838bf1790976a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "commission_rule" DROP CONSTRAINT "FK_7b250de6da53a02d3a91d255a68"`,
    );
    await queryRunner.query(
      `ALTER TABLE "commission_rule" DROP CONSTRAINT "FK_93f6151205640d2f5a157024b35"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_account_allocation" DROP CONSTRAINT "FK_15d961bae7cbf44cda5649a10a6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_account_allocation" DROP CONSTRAINT "FK_040f1307a22c0877436239c49ea"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_account_allocation" DROP CONSTRAINT "FK_61ea8a58fa0af69e8d60b92da68"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement_order" DROP CONSTRAINT "FK_1022fc8018671046aefdab2f8fd"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement_order" DROP CONSTRAINT "FK_00b78dc2e95eff06336c982de3c"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement" DROP CONSTRAINT "FK_353df4e2e3c3e8ffca5e83f1ede"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement" DROP CONSTRAINT "FK_dce1f0f1e826575bf49d6a5776f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement" DROP CONSTRAINT "FK_75d32540838e7084b7c0eb113e0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement" DROP CONSTRAINT "FK_4e7b4890ff3e759f07c7c215501"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement" DROP CONSTRAINT "FK_1751ff46c2e373bb36f760c3607"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement" DROP CONSTRAINT "FK_841e7f13d74799b8be10aab1fbf"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement" DROP CONSTRAINT "FK_034a404a6b3c046410baaccd6bf"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement_expense" DROP CONSTRAINT "FK_e1279555100a50a59f7d6225db7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement_expense" DROP CONSTRAINT "FK_81dfc131cc2b6c5d5aa5b4a854f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement_collection" DROP CONSTRAINT "FK_5a1110f63b59aadf68c65085ee0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "driver_settlement_collection" DROP CONSTRAINT "FK_ffffe9c244ec6bc721223a622a6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_account_entry" DROP CONSTRAINT "FK_461301da4afa2be775baa570c22"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_account_entry" DROP CONSTRAINT "FK_1401ec5da7e64330b406b3fbfa9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_account_entry" DROP CONSTRAINT "FK_39f5f1bf029ec0921d6c9d81795"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_account_entry" DROP CONSTRAINT "FK_24670e6df94198c58ad163ecce4"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_account_entry" DROP CONSTRAINT "FK_3f917672bdb3f9fa953b197a1d6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_account_entry" DROP CONSTRAINT "FK_d9a03fad3dae8ac9c53de957b96"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_account" DROP CONSTRAINT "FK_05d48d2b9438d97c70797088f72"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_account" DROP CONSTRAINT "FK_564bc79a7c5208b8a2e451f33ee"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_movement" DROP CONSTRAINT "FK_b4ddcca770fe0f7b5b7c8131d25"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_movement" DROP CONSTRAINT "FK_8e5c5ff29d543ee1e3a3d26a4a7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_movement" DROP CONSTRAINT "FK_b1f34c53c367143701b9164785e"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_movement" DROP CONSTRAINT "FK_d704d3ac4a86b13e238da3d4083"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_movement" DROP CONSTRAINT "FK_a9b982c8aec7c799a146f449e25"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_movement" DROP CONSTRAINT "FK_309ab225b94de04ab0ee244d6a9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_session" DROP CONSTRAINT "FK_8fd04897962bec0681603f29421"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_session" DROP CONSTRAINT "FK_24c1c29632e21025336adc2d2c1"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_session" DROP CONSTRAINT "FK_566ccda1abee03369e83fbdac52"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_session" DROP CONSTRAINT "FK_cba986fb1ad57b98770e517d9b8"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_category" DROP CONSTRAINT "FK_1528db3a4ea037a767795b0d9c9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_box" DROP CONSTRAINT "FK_cf2a6266f8dc0f2d942fe88aa6e"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_commission_entry_empleado"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_commission_entry_liquidacion"`,
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_commission_entry_pedido"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_commission_entry_faltante"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_commission_entry_distributor"`,
    );
    await queryRunner.query(`DROP TABLE "commission_entry"`);
    await queryRunner.query(`DROP TYPE "public"."commission_entry_type_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_driver_liquidation_numero"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_driver_liquidation_empleado"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_driver_liquidation_distributor"`,
    );
    await queryRunner.query(`DROP TABLE "driver_liquidation"`);
    await queryRunner.query(
      `DROP TYPE "public"."driver_liquidation_status_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_commission_rule_distribuidora"`,
    );
    await queryRunner.query(`DROP TABLE "commission_rule"`);
    await queryRunner.query(`DROP TYPE "public"."commission_rule_basis_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_customer_account_allocation_credito"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_customer_account_allocation_debito"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_customer_account_allocation_cuenta"`,
    );
    await queryRunner.query(`DROP TABLE "customer_account_allocation"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_driver_settlement_order_pedido"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_driver_settlement_order_rendicion"`,
    );
    await queryRunner.query(`DROP TABLE "driver_settlement_order"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_driver_settlement_numero"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_driver_settlement_chofer_dia"`,
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_driver_settlement_carga"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_driver_settlement_fecha"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_driver_settlement_estado"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_driver_settlement_chofer"`,
    );
    await queryRunner.query(`DROP TABLE "driver_settlement"`);
    await queryRunner.query(
      `DROP TYPE "public"."driver_settlement_difference_resolution_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."driver_settlement_status_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_driver_settlement_expense_rendicion"`,
    );
    await queryRunner.query(`DROP TABLE "driver_settlement_expense"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_driver_settlement_collection_asiento"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_driver_settlement_collection_rendicion"`,
    );
    await queryRunner.query(`DROP TABLE "driver_settlement_collection"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_customer_account_entry_cuenta_fecha"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_customer_account_entry_cargo_pedido"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_customer_account_entry_distributor"`,
    );
    await queryRunner.query(`DROP TABLE "customer_account_entry"`);
    await queryRunner.query(
      `DROP TYPE "public"."customer_account_entry_type_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_customer_account_cliente_vigente"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_customer_account_distributor"`,
    );
    await queryRunner.query(`DROP TABLE "customer_account"`);
    await queryRunner.query(
      `DROP TYPE "public"."customer_account_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."customer_account_tax_condition_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_cash_movement_caja_fecha"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_cash_movement_distribuidora_fecha"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_cash_movement_referencia"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_cash_movement_sesion"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_cash_movement_anula"`);
    await queryRunner.query(`DROP TABLE "cash_movement"`);
    await queryRunner.query(
      `DROP TYPE "public"."cash_movement_reference_type_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."cash_movement_method_enum"`);
    await queryRunner.query(
      `DROP TYPE "public"."cash_movement_direction_enum"`,
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_cash_session_abierta"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_cash_session_caja_fecha"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_cash_session_distributor"`,
    );
    await queryRunner.query(`DROP TABLE "cash_session"`);
    await queryRunner.query(`DROP TYPE "public"."cash_session_status_enum"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_cash_category_sistema"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_cash_category_nombre_activa"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_cash_category_distributor"`,
    );
    await queryRunner.query(`DROP TABLE "cash_category"`);
    await queryRunner.query(
      `DROP TYPE "public"."cash_category_system_code_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."cash_category_direction_enum"`,
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_cash_box_nombre_vigente"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_cash_box_distributor"`);
    await queryRunner.query(`DROP TABLE "cash_box"`);
    await queryRunner.query(`DROP TYPE "public"."cash_box_kind_enum"`);
  }
}
