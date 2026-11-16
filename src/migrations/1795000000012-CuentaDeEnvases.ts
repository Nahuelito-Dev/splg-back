import { MigrationInterface, QueryRunner } from 'typeorm';

/** Cuenta agregada y libro inmutable de envases propios por cliente y tipo. */
export class CuentaDeEnvases1795000000012 implements MigrationInterface {
  name = 'CuentaDeEnvases1795000000012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."customer_container_movement_reason_enum" AS ENUM('initial_from_deliveries', 'purchased', 'manual_adjustment', 'returned')`,
    );
    await queryRunner.query(
      `CREATE TABLE "customer_container_account" (
        "account_id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "distributor_id" uuid NOT NULL,
        "customer_user_id" uuid NOT NULL,
        "gas_cylinder_id" uuid NOT NULL,
        "owned" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_customer_container_account" PRIMARY KEY ("account_id"),
        CONSTRAINT "UQ_customer_container_account_cliente_tipo" UNIQUE ("distributor_id", "customer_user_id", "gas_cylinder_id"),
        CONSTRAINT "UQ_customer_container_account_id_distribuidora" UNIQUE ("account_id", "distributor_id"),
        CONSTRAINT "CHK_customer_container_account_owned" CHECK ("owned" >= 0)
      )`,
    );
    await queryRunner.query(
      `CREATE TABLE "customer_container_movement" (
        "movement_id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "account_id" uuid NOT NULL,
        "distributor_id" uuid NOT NULL,
        "quantity" integer NOT NULL,
        "reason" "public"."customer_container_movement_reason_enum" NOT NULL,
        "order_id" uuid,
        "note" text,
        "actor_user_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_customer_container_movement" PRIMARY KEY ("movement_id"),
        CONSTRAINT "CHK_customer_container_movement_quantity" CHECK ("quantity" <> 0),
        CONSTRAINT "CHK_customer_container_movement_note" CHECK ("reason" <> 'manual_adjustment' OR char_length(btrim("note")) BETWEEN 10 AND 500)
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_customer_container_account_cliente" ON "customer_container_account" ("distributor_id", "customer_user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_customer_container_movement_account_created" ON "customer_container_movement" ("account_id", "created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_customer_container_movement_inicial" ON "customer_container_movement" ("account_id") WHERE "reason" = 'initial_from_deliveries'`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_container_account" ADD CONSTRAINT "FK_customer_container_account_distributor" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE RESTRICT`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_container_account" ADD CONSTRAINT "FK_customer_container_account_cliente" FOREIGN KEY ("customer_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_container_account" ADD CONSTRAINT "FK_customer_container_account_gas_cylinder_distribuidora" FOREIGN KEY ("gas_cylinder_id", "distributor_id") REFERENCES "gas_cylinder"("gas_cylinder_id", "distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_container_movement" ADD CONSTRAINT "FK_customer_container_movement_account_distribuidora" FOREIGN KEY ("account_id", "distributor_id") REFERENCES "customer_container_account"("account_id", "distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_container_movement" ADD CONSTRAINT "FK_customer_container_movement_order_distribuidora" FOREIGN KEY ("order_id", "distributor_id") REFERENCES "order"("order_id", "distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_container_movement" ADD CONSTRAINT "FK_customer_container_movement_actor" FOREIGN KEY ("actor_user_id") REFERENCES "user"("user_id") ON DELETE SET NULL`,
    );
    // Dos sentencias: en una sola, el UPDATE final no ve las cuentas que insertó una CTE anterior.
    await queryRunner.query(`
      WITH maximos AS (
        SELECT o.distributor_id, o.customer_id, oi.gas_cylinder_id,
               MAX(oi.quantity)::int AS owned
        FROM "order" o
        JOIN order_item oi ON oi.order_id = o.order_id
        WHERE o.status = 'delivered'
        GROUP BY o.distributor_id, o.customer_id, oi.gas_cylinder_id
      )
      INSERT INTO customer_container_account
        (distributor_id, customer_user_id, gas_cylinder_id)
      SELECT distributor_id, customer_id, gas_cylinder_id FROM maximos
      ON CONFLICT (distributor_id, customer_user_id, gas_cylinder_id) DO NOTHING
    `);
    await queryRunner.query(`
      WITH maximos AS (
        SELECT o.distributor_id, o.customer_id, oi.gas_cylinder_id,
               MAX(oi.quantity)::int AS owned
        FROM "order" o
        JOIN order_item oi ON oi.order_id = o.order_id
        WHERE o.status = 'delivered'
        GROUP BY o.distributor_id, o.customer_id, oi.gas_cylinder_id
      ), iniciales AS (
        INSERT INTO customer_container_movement
          (account_id, distributor_id, quantity, reason)
        SELECT a.account_id, a.distributor_id, m.owned, 'initial_from_deliveries'
        FROM customer_container_account a
        JOIN maximos m ON m.distributor_id = a.distributor_id
          AND m.customer_id = a.customer_user_id
          AND m.gas_cylinder_id = a.gas_cylinder_id
        WHERE m.owned > 0
        ON CONFLICT (account_id) WHERE reason = 'initial_from_deliveries'
          DO NOTHING
        RETURNING account_id, quantity
      )
      UPDATE customer_container_account a
      SET owned = a.owned + i.quantity, updated_at = now()
      FROM iniciales i
      WHERE a.account_id = i.account_id
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "customer_container_movement"`);
    await queryRunner.query(`DROP TABLE "customer_container_account"`);
    await queryRunner.query(
      `DROP TYPE "public"."customer_container_movement_reason_enum"`,
    );
  }
}
