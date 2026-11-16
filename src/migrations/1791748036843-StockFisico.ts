import { MigrationInterface, QueryRunner } from 'typeorm';

export class StockFisico1791748036843 implements MigrationInterface {
  name = 'StockFisico1791748036843';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."warehouse_kind_enum" AS ENUM('depot', 'branch')`,
    );
    await queryRunner.query(
      `CREATE TABLE "warehouse" ("warehouse_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "name" character varying(80) NOT NULL, "code" character varying(12) NOT NULL, "kind" "public"."warehouse_kind_enum" NOT NULL DEFAULT 'depot', "address" text, "is_default" boolean NOT NULL DEFAULT false, "is_active" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_897d6a7341d8b835d3368b91b8c" PRIMARY KEY ("warehouse_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_warehouse_distributor" ON "warehouse" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_warehouse_default_vigente" ON "warehouse" ("distributor_id") WHERE "is_default" AND "deletedAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_warehouse_code_vigente" ON "warehouse" ("distributor_id", "code") WHERE "deletedAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE TABLE "stock_threshold" ("threshold_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "warehouse_id" uuid NOT NULL, "gas_cylinder_id" uuid NOT NULL, "min_full" integer NOT NULL, "alerted_at" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_stock_threshold_minimo" CHECK ("min_full" >= 0), CONSTRAINT "PK_111cca2010115947ad3ed0a00d5" PRIMARY KEY ("threshold_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_stock_threshold_distributor" ON "stock_threshold" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_stock_threshold_deposito_garrafa" ON "stock_threshold" ("warehouse_id", "gas_cylinder_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."stock_location_kind_enum" AS ENUM('warehouse', 'vehicle')`,
    );
    await queryRunner.query(
      `CREATE TABLE "stock_location" ("location_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "kind" "public"."stock_location_kind_enum" NOT NULL, "warehouse_id" uuid, "car_id" uuid, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_stock_location_kind" CHECK (("kind" = 'warehouse') = ("warehouse_id" IS NOT NULL)), CONSTRAINT "CHK_stock_location_one_owner" CHECK (num_nonnulls("warehouse_id", "car_id") = 1), CONSTRAINT "PK_db70b5a5252bd3e2b11d488746c" PRIMARY KEY ("location_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_stock_location_distributor" ON "stock_location" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_stock_location_car" ON "stock_location" ("car_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_stock_location_warehouse" ON "stock_location" ("warehouse_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."stock_condition_enum" AS ENUM('full', 'empty', 'defective')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."stock_movement_reason_enum" AS ENUM('initial_count', 'purchase_receipt', 'plant_empty_out', 'truck_load', 'truck_return', 'delivery', 'empty_collected', 'transfer', 'adjustment', 'shrinkage', 'condition_change', 'reversal')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."stock_movement_reference_type_enum" AS ENUM('order', 'purchase_receipt', 'truck_load', 'stock_adjustment', 'transfer', 'initial')`,
    );
    await queryRunner.query(
      `CREATE TABLE "stock_movement" ("movement_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "gas_cylinder_id" uuid NOT NULL, "batch_id" uuid NOT NULL, "quantity" integer NOT NULL, "from_location_id" uuid, "from_condition" "public"."stock_condition_enum", "to_location_id" uuid, "to_condition" "public"."stock_condition_enum", "reason" "public"."stock_movement_reason_enum" NOT NULL, "reference_type" "public"."stock_movement_reference_type_enum" NOT NULL, "reference_id" uuid, "reversed_movement_id" uuid, "notes" character varying(300), "actor_user_id" uuid, "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_stock_movement_destino_coherente" CHECK (("to_location_id" IS NULL) = ("to_condition" IS NULL)), CONSTRAINT "CHK_stock_movement_origen_coherente" CHECK (("from_location_id" IS NULL) = ("from_condition" IS NULL)), CONSTRAINT "CHK_stock_movement_origen_o_destino" CHECK ("from_location_id" IS NOT NULL OR "to_location_id" IS NOT NULL), CONSTRAINT "CHK_stock_movement_cantidad" CHECK ("quantity" > 0), CONSTRAINT "PK_208ac76bb0d2e300ce89781b22b" PRIMARY KEY ("movement_id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_stock_movement_contraasiento" ON "stock_movement" ("reversed_movement_id") WHERE "reversed_movement_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_stock_movement_pedido" ON "stock_movement" ("reference_id", "gas_cylinder_id", "reason") WHERE "reference_type" = 'order' AND "reason" <> 'reversal'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_stock_movement_lote" ON "stock_movement" ("batch_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_stock_movement_referencia" ON "stock_movement" ("reference_type", "reference_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_stock_movement_destino" ON "stock_movement" ("to_location_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_stock_movement_origen" ON "stock_movement" ("from_location_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_stock_movement_garrafa_fecha" ON "stock_movement" ("gas_cylinder_id", "occurred_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_stock_movement_fecha" ON "stock_movement" ("distributor_id", "occurred_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "stock_balance" ("balance_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "location_id" uuid NOT NULL, "gas_cylinder_id" uuid NOT NULL, "condition" "public"."stock_condition_enum" NOT NULL, "quantity" integer NOT NULL DEFAULT '0', "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_stock_balance_no_negativo" CHECK ("quantity" >= 0), CONSTRAINT "PK_47028cd798909484a9f5f9b0bd2" PRIMARY KEY ("balance_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_stock_balance_distributor" ON "stock_balance" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_stock_balance_gas_cylinder" ON "stock_balance" ("gas_cylinder_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_stock_balance_ubicacion_garrafa_condicion" ON "stock_balance" ("location_id", "gas_cylinder_id", "condition") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."stock_adjustment_reason_enum" AS ENUM('count_correction', 'shrinkage', 'leak', 'damaged', 'lost', 'found', 'initial_count')`,
    );
    await queryRunner.query(
      `CREATE TABLE "stock_adjustment" ("adjustment_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "number" integer NOT NULL, "location_id" uuid NOT NULL, "reason" "public"."stock_adjustment_reason_enum" NOT NULL, "notes" text NOT NULL, "batch_id" uuid NOT NULL, "created_by_user_id" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_e922ad5f08b46b85d6a82156378" PRIMARY KEY ("adjustment_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_stock_adjustment_ubicacion" ON "stock_adjustment" ("location_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_stock_adjustment_fecha" ON "stock_adjustment" ("distributor_id", "createdAt") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_stock_adjustment_numero" ON "stock_adjustment" ("distributor_id", "number") `,
    );
    await queryRunner.query(
      `CREATE TABLE "stock_adjustment_item" ("item_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "adjustment_id" uuid NOT NULL, "gas_cylinder_id" uuid NOT NULL, "condition" "public"."stock_condition_enum" NOT NULL, "quantity_delta" integer NOT NULL, CONSTRAINT "CHK_stock_adjustment_item_variacion" CHECK ("quantity_delta" <> 0), CONSTRAINT "PK_ed34c9fcbcbed4fe6d1bcff37c2" PRIMARY KEY ("item_id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_stock_adjustment_item_garrafa_condicion" ON "stock_adjustment_item" ("adjustment_id", "gas_cylinder_id", "condition") `,
    );
    await queryRunner.query(
      `ALTER TABLE "warehouse" ADD CONSTRAINT "FK_8ad23df5bd4c6cd8260cfd1e077" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_threshold" ADD CONSTRAINT "FK_1156a89b5afe382c53f0a156649" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_threshold" ADD CONSTRAINT "FK_ea56f87659c1c21bc76e2b31cd4" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("warehouse_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_threshold" ADD CONSTRAINT "FK_529ba90fe05ac147b100ec4df62" FOREIGN KEY ("gas_cylinder_id") REFERENCES "gas_cylinder"("gas_cylinder_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_location" ADD CONSTRAINT "FK_088aef530fb37a7a19c6b9b4a39" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_location" ADD CONSTRAINT "FK_4b7804c17f9702172ce5c8807d9" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("warehouse_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_location" ADD CONSTRAINT "FK_d88f225ec362c0b11c179a4e034" FOREIGN KEY ("car_id") REFERENCES "car"("car_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movement" ADD CONSTRAINT "FK_17c6850bf48d727614da1067ed2" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movement" ADD CONSTRAINT "FK_55497d12338255dc611b2f4fea1" FOREIGN KEY ("gas_cylinder_id") REFERENCES "gas_cylinder"("gas_cylinder_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movement" ADD CONSTRAINT "FK_cd07883671bb2828c28130d261b" FOREIGN KEY ("from_location_id") REFERENCES "stock_location"("location_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movement" ADD CONSTRAINT "FK_a659cb2aa061b376744c6cb9029" FOREIGN KEY ("to_location_id") REFERENCES "stock_location"("location_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movement" ADD CONSTRAINT "FK_e29e01a939f7c0a5ade184a3bf9" FOREIGN KEY ("reversed_movement_id") REFERENCES "stock_movement"("movement_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movement" ADD CONSTRAINT "FK_9fdaeb1da2e012874563f44702c" FOREIGN KEY ("actor_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_balance" ADD CONSTRAINT "FK_32ff768a1b319c39cf48678a0af" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_balance" ADD CONSTRAINT "FK_f8b2b588f7e7c8868a2756192d4" FOREIGN KEY ("location_id") REFERENCES "stock_location"("location_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_balance" ADD CONSTRAINT "FK_425c43cce61e9a14028ec1115d1" FOREIGN KEY ("gas_cylinder_id") REFERENCES "gas_cylinder"("gas_cylinder_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustment" ADD CONSTRAINT "FK_5579346ced7a6a447d8dee9bc27" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustment" ADD CONSTRAINT "FK_c5705d3d9d138fdefd333817dd1" FOREIGN KEY ("location_id") REFERENCES "stock_location"("location_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustment" ADD CONSTRAINT "FK_86f79cf831d762c7171cd5c5e17" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustment_item" ADD CONSTRAINT "FK_2fa4ce3625472a3239024cc8312" FOREIGN KEY ("adjustment_id") REFERENCES "stock_adjustment"("adjustment_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustment_item" ADD CONSTRAINT "FK_b5df54839d2bc61c3be8207b4ff" FOREIGN KEY ("gas_cylinder_id") REFERENCES "gas_cylinder"("gas_cylinder_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );

    // El libro es de sólo escritura: igual que audit_log, un trigger rechaza
    // todo UPDATE y DELETE. Se corrige con un contraasiento, nunca editando.
    await queryRunner.query(`
      CREATE FUNCTION stock_movement_inmutable() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'stock_movement es de sólo escritura: no se modifican ni se borran movimientos; se corrige con un contraasiento';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER stock_movement_inmutable
      BEFORE UPDATE OR DELETE ON "stock_movement"
      FOR EACH ROW EXECUTE FUNCTION stock_movement_inmutable()
    `);

    // Depósito central predeterminado en cada distribuidora que ya existe.
    await queryRunner.query(`
      INSERT INTO "warehouse" ("distributor_id", "name", "code", "kind", "is_default")
      SELECT "distributor_id", 'Depósito central', 'CENTRAL', 'depot', true
      FROM "distributor"
    `);
    await queryRunner.query(`
      INSERT INTO "stock_location" ("distributor_id", "kind", "warehouse_id")
      SELECT "distributor_id", 'warehouse', "warehouse_id" FROM "warehouse"
    `);

    // Saldo inicial (D4): el vendible de hoy más lo que reservan los pedidos
    // abiertos, todo como llenas del depósito central. Las vacías arrancan en
    // cero: el administrador hace la toma de inventario con el conteo inicial.
    await queryRunner.query(`
      CREATE TEMP TABLE "stock_arranque" ON COMMIT DROP AS
      SELECT gc."gas_cylinder_id", gc."distributor_id", l."location_id",
             (gc."stock" + COALESCE(a."reservado", 0))::int AS "cantidad"
      FROM "gas_cylinder" gc
      JOIN "stock_location" l ON l."distributor_id" = gc."distributor_id"
      LEFT JOIN (
        SELECT oi."gas_cylinder_id", SUM(oi."quantity") AS "reservado"
        FROM "order_item" oi
        JOIN "order" o ON o."order_id" = oi."order_id"
        WHERE o."status" IN ('reserved', 'pending', 'accepted', 'on_the_way')
        GROUP BY oi."gas_cylinder_id"
      ) a ON a."gas_cylinder_id" = gc."gas_cylinder_id"
      WHERE gc."stock" + COALESCE(a."reservado", 0) > 0
    `);
    await queryRunner.query(`
      INSERT INTO "stock_balance" ("distributor_id", "location_id", "gas_cylinder_id", "condition", "quantity")
      SELECT "distributor_id", "location_id", "gas_cylinder_id", 'full', "cantidad"
      FROM "stock_arranque"
    `);
    await queryRunner.query(`
      INSERT INTO "stock_movement"
        ("distributor_id", "gas_cylinder_id", "batch_id", "quantity", "to_location_id", "to_condition",
         "reason", "reference_type", "notes")
      SELECT s."distributor_id", s."gas_cylinder_id", lote."batch_id", s."cantidad", s."location_id", 'full',
             'initial_count', 'initial', 'Saldo inicial: stock vendible más pedidos abiertos'
      FROM "stock_arranque" s
      JOIN (
        SELECT "distributor_id", uuid_generate_v4() AS "batch_id"
        FROM (SELECT DISTINCT "distributor_id" FROM "stock_arranque") d
      ) lote ON lote."distributor_id" = s."distributor_id"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS stock_movement_inmutable ON "stock_movement"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS stock_movement_inmutable()`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustment_item" DROP CONSTRAINT "FK_b5df54839d2bc61c3be8207b4ff"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustment_item" DROP CONSTRAINT "FK_2fa4ce3625472a3239024cc8312"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustment" DROP CONSTRAINT "FK_86f79cf831d762c7171cd5c5e17"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustment" DROP CONSTRAINT "FK_c5705d3d9d138fdefd333817dd1"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustment" DROP CONSTRAINT "FK_5579346ced7a6a447d8dee9bc27"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_balance" DROP CONSTRAINT "FK_425c43cce61e9a14028ec1115d1"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_balance" DROP CONSTRAINT "FK_f8b2b588f7e7c8868a2756192d4"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_balance" DROP CONSTRAINT "FK_32ff768a1b319c39cf48678a0af"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movement" DROP CONSTRAINT "FK_9fdaeb1da2e012874563f44702c"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movement" DROP CONSTRAINT "FK_e29e01a939f7c0a5ade184a3bf9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movement" DROP CONSTRAINT "FK_a659cb2aa061b376744c6cb9029"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movement" DROP CONSTRAINT "FK_cd07883671bb2828c28130d261b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movement" DROP CONSTRAINT "FK_55497d12338255dc611b2f4fea1"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movement" DROP CONSTRAINT "FK_17c6850bf48d727614da1067ed2"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_location" DROP CONSTRAINT "FK_d88f225ec362c0b11c179a4e034"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_location" DROP CONSTRAINT "FK_4b7804c17f9702172ce5c8807d9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_location" DROP CONSTRAINT "FK_088aef530fb37a7a19c6b9b4a39"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_threshold" DROP CONSTRAINT "FK_529ba90fe05ac147b100ec4df62"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_threshold" DROP CONSTRAINT "FK_ea56f87659c1c21bc76e2b31cd4"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_threshold" DROP CONSTRAINT "FK_1156a89b5afe382c53f0a156649"`,
    );
    await queryRunner.query(
      `ALTER TABLE "warehouse" DROP CONSTRAINT "FK_8ad23df5bd4c6cd8260cfd1e077"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_stock_adjustment_item_garrafa_condicion"`,
    );
    await queryRunner.query(`DROP TABLE "stock_adjustment_item"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_stock_adjustment_numero"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_stock_adjustment_fecha"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_stock_adjustment_ubicacion"`,
    );
    await queryRunner.query(`DROP TABLE "stock_adjustment"`);
    await queryRunner.query(
      `DROP TYPE "public"."stock_adjustment_reason_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_stock_balance_ubicacion_garrafa_condicion"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_stock_balance_gas_cylinder"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_stock_balance_distributor"`,
    );
    await queryRunner.query(`DROP TABLE "stock_balance"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_stock_movement_fecha"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_stock_movement_garrafa_fecha"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_stock_movement_origen"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_stock_movement_destino"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_stock_movement_referencia"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_stock_movement_lote"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_stock_movement_pedido"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_stock_movement_contraasiento"`,
    );
    await queryRunner.query(`DROP TABLE "stock_movement"`);
    await queryRunner.query(
      `DROP TYPE "public"."stock_movement_reference_type_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."stock_movement_reason_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_stock_location_warehouse"`,
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_stock_location_car"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_stock_location_distributor"`,
    );
    await queryRunner.query(`DROP TABLE "stock_location"`);
    await queryRunner.query(`DROP TYPE "public"."stock_condition_enum"`);
    await queryRunner.query(`DROP TYPE "public"."stock_location_kind_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_stock_threshold_deposito_garrafa"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_stock_threshold_distributor"`,
    );
    await queryRunner.query(`DROP TABLE "stock_threshold"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_warehouse_code_vigente"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_warehouse_default_vigente"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_warehouse_distributor"`);
    await queryRunner.query(`DROP TABLE "warehouse"`);
    await queryRunner.query(`DROP TYPE "public"."warehouse_kind_enum"`);
  }
}
