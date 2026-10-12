import { MigrationInterface, QueryRunner } from 'typeorm';

export class Compras1791752164368 implements MigrationInterface {
  name = 'Compras1791752164368';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."supplier_kind_enum" AS ENUM('filling_plant', 'other')`,
    );
    await queryRunner.query(
      `CREATE TABLE "supplier" ("supplier_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "business_name" character varying(120) NOT NULL, "cuit" character varying(11) NOT NULL, "kind" "public"."supplier_kind_enum" NOT NULL DEFAULT 'other', "contact_name" character varying(80), "phone" character varying(30), "email" character varying(120), "address" text, "payment_terms_days" integer, "is_active" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_e0f8ee60663218082b83251cd85" PRIMARY KEY ("supplier_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_supplier_distributor" ON "supplier" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_supplier_cuit_vigente" ON "supplier" ("distributor_id", "cuit") WHERE "deletedAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE TABLE "purchase_order_item" ("item_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "purchase_order_id" uuid NOT NULL, "gas_cylinder_id" uuid NOT NULL, "quantity" integer NOT NULL, "unit_cost" numeric(12,2) NOT NULL, "empties_to_exchange" integer NOT NULL DEFAULT '0', "received_quantity" integer NOT NULL DEFAULT '0', CONSTRAINT "CHK_purchase_order_item_costo" CHECK ("unit_cost" >= 0), CONSTRAINT "CHK_purchase_order_item_recibido" CHECK ("received_quantity" >= 0 AND "received_quantity" <= "quantity"), CONSTRAINT "CHK_purchase_order_item_vacios" CHECK ("empties_to_exchange" >= 0), CONSTRAINT "CHK_purchase_order_item_cantidad" CHECK ("quantity" > 0), CONSTRAINT "PK_279be0517e992507405a8370859" PRIMARY KEY ("item_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_purchase_order_item_garrafa" ON "purchase_order_item" ("gas_cylinder_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_purchase_order_item_garrafa" ON "purchase_order_item" ("purchase_order_id", "gas_cylinder_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."purchase_order_status_enum" AS ENUM('draft', 'sent', 'partially_received', 'received', 'cancelled')`,
    );
    await queryRunner.query(
      `CREATE TABLE "purchase_order" ("purchase_order_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "number" integer NOT NULL, "supplier_id" uuid NOT NULL, "destination_warehouse_id" uuid NOT NULL, "status" "public"."purchase_order_status_enum" NOT NULL DEFAULT 'draft', "issued_at" TIMESTAMP WITH TIME ZONE, "expected_date" date, "total_amount" numeric(12,2) NOT NULL DEFAULT '0', "cancel_reason" text, "notes" text, "created_by_user_id" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_fab0d2c491acac8ad11df9c5c35" PRIMARY KEY ("purchase_order_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_purchase_order_proveedor" ON "purchase_order" ("supplier_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_purchase_order_estado" ON "purchase_order" ("distributor_id", "status") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_purchase_order_numero" ON "purchase_order" ("distributor_id", "number") `,
    );
    await queryRunner.query(
      `CREATE TABLE "purchase_receipt_item" ("item_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "receipt_id" uuid NOT NULL, "gas_cylinder_id" uuid NOT NULL, "quantity_full" integer NOT NULL, "quantity_empty_out" integer NOT NULL DEFAULT '0', "unit_cost" numeric(12,2) NOT NULL, CONSTRAINT "CHK_purchase_receipt_item_costo" CHECK ("unit_cost" >= 0), CONSTRAINT "CHK_purchase_receipt_item_cantidades" CHECK ("quantity_full" >= 0 AND "quantity_empty_out" >= 0 AND ("quantity_full" + "quantity_empty_out") > 0), CONSTRAINT "PK_7337109e82b7ce3f2b240f3cf01" PRIMARY KEY ("item_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_purchase_receipt_item_garrafa" ON "purchase_receipt_item" ("gas_cylinder_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_purchase_receipt_item_garrafa" ON "purchase_receipt_item" ("receipt_id", "gas_cylinder_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."supplier_document_type_enum" AS ENUM('delivery_note', 'invoice')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."purchase_payment_status_enum" AS ENUM('unpaid', 'paid')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."purchase_receipt_status_enum" AS ENUM('confirmed', 'voided')`,
    );
    await queryRunner.query(
      `CREATE TABLE "purchase_receipt" ("receipt_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "number" integer NOT NULL, "supplier_id" uuid NOT NULL, "purchase_order_id" uuid, "warehouse_id" uuid NOT NULL, "supplier_document_type" "public"."supplier_document_type_enum" NOT NULL, "supplier_document_number" character varying(30) NOT NULL, "received_at" TIMESTAMP WITH TIME ZONE NOT NULL, "received_by_user_id" uuid NOT NULL, "total_amount" numeric(12,2) NOT NULL DEFAULT '0', "payment_status" "public"."purchase_payment_status_enum" NOT NULL DEFAULT 'unpaid', "cash_movement_id" uuid, "status" "public"."purchase_receipt_status_enum" NOT NULL DEFAULT 'confirmed', "void_reason" text, "voided_at" TIMESTAMP WITH TIME ZONE, "voided_by_user_id" uuid, "batch_id" uuid NOT NULL, "void_batch_id" uuid, "notes" text, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_84843cd0babb399d9c6df92e785" PRIMARY KEY ("receipt_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_purchase_receipt_proveedor" ON "purchase_receipt" ("supplier_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_purchase_receipt_orden" ON "purchase_receipt" ("purchase_order_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_purchase_receipt_fecha" ON "purchase_receipt" ("distributor_id", "received_at") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_purchase_receipt_documento_proveedor" ON "purchase_receipt" ("distributor_id", "supplier_id", "supplier_document_number") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_purchase_receipt_numero" ON "purchase_receipt" ("distributor_id", "number") `,
    );
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder" ADD "average_unit_cost" numeric(12,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "supplier" ADD CONSTRAINT "FK_953a1f52f2a158e012b00e2627d" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_item" ADD CONSTRAINT "FK_1c77f592d2af177be137dac042a" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_order"("purchase_order_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_item" ADD CONSTRAINT "FK_a4196dc0466b5156def25a8ee12" FOREIGN KEY ("gas_cylinder_id") REFERENCES "gas_cylinder"("gas_cylinder_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order" ADD CONSTRAINT "FK_c00afbc3e2836ac46be7c45ca78" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order" ADD CONSTRAINT "FK_3dacab5c4a43cecc0e48f5edb12" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("supplier_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order" ADD CONSTRAINT "FK_135e724d2360c7c75d6ea398636" FOREIGN KEY ("destination_warehouse_id") REFERENCES "warehouse"("warehouse_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order" ADD CONSTRAINT "FK_21c76d5dfdb1773bc03cc6db1f1" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_receipt_item" ADD CONSTRAINT "FK_b391d5552738cae006c0b9bf801" FOREIGN KEY ("receipt_id") REFERENCES "purchase_receipt"("receipt_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_receipt_item" ADD CONSTRAINT "FK_9309591adbb21562263e935c340" FOREIGN KEY ("gas_cylinder_id") REFERENCES "gas_cylinder"("gas_cylinder_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_receipt" ADD CONSTRAINT "FK_e5c3319a7128d4f1758e0f97d97" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_receipt" ADD CONSTRAINT "FK_a5906b092909ffdf5c1a75b308b" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("supplier_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_receipt" ADD CONSTRAINT "FK_d8373964f8a5c4fa998a23fc0d2" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_order"("purchase_order_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_receipt" ADD CONSTRAINT "FK_655cac7fe6e17056c412e0164d0" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("warehouse_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_receipt" ADD CONSTRAINT "FK_c92afda2aff490f63e02ea303bb" FOREIGN KEY ("received_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "purchase_receipt" DROP CONSTRAINT "FK_c92afda2aff490f63e02ea303bb"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_receipt" DROP CONSTRAINT "FK_655cac7fe6e17056c412e0164d0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_receipt" DROP CONSTRAINT "FK_d8373964f8a5c4fa998a23fc0d2"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_receipt" DROP CONSTRAINT "FK_a5906b092909ffdf5c1a75b308b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_receipt" DROP CONSTRAINT "FK_e5c3319a7128d4f1758e0f97d97"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_receipt_item" DROP CONSTRAINT "FK_9309591adbb21562263e935c340"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_receipt_item" DROP CONSTRAINT "FK_b391d5552738cae006c0b9bf801"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order" DROP CONSTRAINT "FK_21c76d5dfdb1773bc03cc6db1f1"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order" DROP CONSTRAINT "FK_135e724d2360c7c75d6ea398636"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order" DROP CONSTRAINT "FK_3dacab5c4a43cecc0e48f5edb12"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order" DROP CONSTRAINT "FK_c00afbc3e2836ac46be7c45ca78"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_item" DROP CONSTRAINT "FK_a4196dc0466b5156def25a8ee12"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_item" DROP CONSTRAINT "FK_1c77f592d2af177be137dac042a"`,
    );
    await queryRunner.query(
      `ALTER TABLE "supplier" DROP CONSTRAINT "FK_953a1f52f2a158e012b00e2627d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "gas_cylinder" DROP COLUMN "average_unit_cost"`,
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_purchase_receipt_numero"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_purchase_receipt_documento_proveedor"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_purchase_receipt_fecha"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_purchase_receipt_orden"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_purchase_receipt_proveedor"`,
    );
    await queryRunner.query(`DROP TABLE "purchase_receipt"`);
    await queryRunner.query(
      `DROP TYPE "public"."purchase_receipt_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."purchase_payment_status_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."supplier_document_type_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_purchase_receipt_item_garrafa"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_purchase_receipt_item_garrafa"`,
    );
    await queryRunner.query(`DROP TABLE "purchase_receipt_item"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_purchase_order_numero"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_purchase_order_estado"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_purchase_order_proveedor"`,
    );
    await queryRunner.query(`DROP TABLE "purchase_order"`);
    await queryRunner.query(`DROP TYPE "public"."purchase_order_status_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_purchase_order_item_garrafa"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_purchase_order_item_garrafa"`,
    );
    await queryRunner.query(`DROP TABLE "purchase_order_item"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_supplier_cuit_vigente"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_supplier_distributor"`);
    await queryRunner.query(`DROP TABLE "supplier"`);
    await queryRunner.query(`DROP TYPE "public"."supplier_kind_enum"`);
  }
}
