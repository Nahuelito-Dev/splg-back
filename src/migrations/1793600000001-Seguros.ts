import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * API v2, seguros de los vehículos (F14): aseguradoras, pólizas y cuotas.
 *
 * - Todo cuelga de una distribuidora y las claves compuestas
 *   `(id, distributor_id)` impiden referenciar un vehículo, una aseguradora, una
 *   póliza o un movimiento de caja de otra.
 * - `EXC_insurance_policy_solapada`: un vehículo no tiene dos pólizas no
 *   canceladas con vigencias solapadas (`[valid_from, valid_to)`: la renovación
 *   puede empezar el día en que vence la anterior).
 * - `CHK_insurance_installment_pagada`: una cuota paga tiene fecha, importe,
 *   quién pagó, el egreso de caja y el comprobante; una que no está paga, ninguno.
 * - Siembra la categoría de sistema «Seguros» (egreso) en las distribuidoras
 *   existentes; las nuevas la reciben con las demás.
 * Usa los valores de enum que agrega `SegurosEnumsDeCajaYAdjuntos`.
 */
export class Seguros1793600000001 implements MigrationInterface {
  name = 'Seguros1793600000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "insurer" ("insurer_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "name" character varying(120) NOT NULL, "tax_id" character varying(11), "phone" character varying(40), "email" character varying(120), "website" character varying(255), "payment_url" character varying(500), "notes" text, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_insurer_id_distribuidora" UNIQUE ("insurer_id", "distributor_id"), CONSTRAINT "CHK_insurer_nombre" CHECK (char_length(btrim("name")) >= 2), CONSTRAINT "CHK_insurer_enlaces" CHECK (("payment_url" IS NULL OR "payment_url" ~ '^https://[^[:space:]]+$') AND ("website" IS NULL OR "website" ~ '^https?://[^[:space:]]+$')), CONSTRAINT "CHK_insurer_cuit" CHECK ("tax_id" IS NULL OR es_cuit_valido("tax_id")), CONSTRAINT "PK_3a73b7503c7741bc9c9917101cf" PRIMARY KEY ("insurer_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_insurer_distributor" ON "insurer" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."insurance_installment_status_enum" AS ENUM('pending', 'paid', 'cancelled')`,
    );
    await queryRunner.query(
      `CREATE TABLE "insurance_installment" ("installment_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "policy_id" uuid NOT NULL, "number" integer NOT NULL, "total" integer NOT NULL, "due_date" date NOT NULL, "grace_until" date NOT NULL, "amount" numeric(12,2) NOT NULL, "status" "public"."insurance_installment_status_enum" NOT NULL DEFAULT 'pending', "paid_at" TIMESTAMP WITH TIME ZONE, "paid_amount" numeric(12,2), "operation_number" character varying(60), "paid_by_user_id" uuid, "cash_movement_id" uuid, "receipt_attachment_id" uuid, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_insurance_installment_id_distribuidora" UNIQUE ("installment_id", "distributor_id"), CONSTRAINT "CHK_insurance_installment_pagada" CHECK (("status" = 'paid' AND num_nonnulls("paid_at", "paid_amount", "paid_by_user_id", "cash_movement_id", "receipt_attachment_id") = 5 AND "paid_amount" > 0) OR ("status" <> 'paid' AND num_nonnulls("paid_at", "paid_amount", "operation_number", "paid_by_user_id", "cash_movement_id", "receipt_attachment_id") = 0)), CONSTRAINT "CHK_insurance_installment_gracia" CHECK ("grace_until" >= "due_date"), CONSTRAINT "CHK_insurance_installment_numero" CHECK ("number" >= 1 AND "total" >= 1 AND "number" <= "total"), CONSTRAINT "CHK_insurance_installment_importe" CHECK ("amount" > 0), CONSTRAINT "PK_aee525717b83161e3ac3015a845" PRIMARY KEY ("installment_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_insurance_installment_distributor" ON "insurance_installment" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_insurance_installment_vencimiento" ON "insurance_installment" ("distributor_id", "status", "due_date") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_insurance_installment_numero" ON "insurance_installment" ("policy_id", "number") `,
    );
    await queryRunner.query(
      `CREATE TABLE "insurance_policy" ("policy_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "car_id" uuid NOT NULL, "insurer_id" uuid NOT NULL, "policy_number" character varying(40) NOT NULL, "coverage" text NOT NULL, "valid_from" date NOT NULL, "valid_to" date NOT NULL, "payment_code" character varying(60), "cancelled_at" TIMESTAMP WITH TIME ZONE, "cancel_reason" text, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_insurance_policy_id_distribuidora" UNIQUE ("policy_id", "distributor_id"), CONSTRAINT "CHK_insurance_policy_textos" CHECK (char_length(btrim("policy_number")) >= 1 AND char_length(btrim("coverage")) >= 1), CONSTRAINT "CHK_insurance_policy_cancelada" CHECK (("cancelled_at" IS NULL AND "cancel_reason" IS NULL) OR ("cancelled_at" IS NOT NULL AND btrim(coalesce("cancel_reason", '')) <> '')), CONSTRAINT "CHK_insurance_policy_vigencia" CHECK ("valid_to" > "valid_from"), CONSTRAINT "PK_f0c1c6967b7573477838fd5d87f" PRIMARY KEY ("policy_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_insurance_policy_distributor" ON "insurance_policy" ("distributor_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_insurance_policy_car" ON "insurance_policy" ("car_id", "valid_from") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_insurance_policy_numero_vigente" ON "insurance_policy" ("distributor_id", "insurer_id", "policy_number") WHERE "cancelled_at" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurer" ADD CONSTRAINT "FK_065c967be7908402287a8a75cc1" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" ADD CONSTRAINT "FK_669ab39fd68649a5ddaccc9f318" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" ADD CONSTRAINT "FK_9993987124d04a4b1e4792e4380" FOREIGN KEY ("policy_id") REFERENCES "insurance_policy"("policy_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" ADD CONSTRAINT "FK_852ffa13f211e5f23a17165ab0e" FOREIGN KEY ("paid_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" ADD CONSTRAINT "FK_eadf2703c66f95dad99f29b3bb4" FOREIGN KEY ("receipt_attachment_id") REFERENCES "attachment"("attachment_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" ADD CONSTRAINT "FK_insurance_installment_cash_movement" FOREIGN KEY ("cash_movement_id") REFERENCES "cash_movement"("movement_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" ADD CONSTRAINT "FK_insurance_installment_cash_movement_distribuidora" FOREIGN KEY ("cash_movement_id", "distributor_id") REFERENCES "cash_movement"("movement_id","distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" ADD CONSTRAINT "FK_insurance_installment_policy_distribuidora" FOREIGN KEY ("policy_id", "distributor_id") REFERENCES "insurance_policy"("policy_id","distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_policy" ADD CONSTRAINT "FK_4f37c7f40a994811b13f0321402" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_policy" ADD CONSTRAINT "FK_a8291ef34a06769c7dd2d1a9499" FOREIGN KEY ("car_id") REFERENCES "car"("car_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_policy" ADD CONSTRAINT "FK_ff1cbeb268c9cc622ac2c402d23" FOREIGN KEY ("insurer_id") REFERENCES "insurer"("insurer_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_policy" ADD CONSTRAINT "FK_insurance_policy_insurer_distribuidora" FOREIGN KEY ("insurer_id", "distributor_id") REFERENCES "insurer"("insurer_id","distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_policy" ADD CONSTRAINT "FK_insurance_policy_car_distribuidora" FOREIGN KEY ("car_id", "distributor_id") REFERENCES "car"("car_id","distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_insurer_nombre_vigente" ON "insurer" ("distributor_id", lower(btrim("name"))) WHERE "deletedAt" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_policy" ADD CONSTRAINT "EXC_insurance_policy_solapada" EXCLUDE USING gist ("car_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&) WHERE ("cancelled_at" IS NULL)`,
    );
    await queryRunner.query(`
            INSERT INTO "cash_category" ("distributor_id", "name", "direction", "system_code")
            SELECT d."distributor_id", 'Seguros', 'expense'::"public"."cash_category_direction_enum", 'insurance'::"public"."cash_category_system_code_enum"
            FROM "distributor" d
            WHERE NOT EXISTS (
              SELECT 1 FROM "cash_category" c WHERE c."distributor_id" = d."distributor_id" AND c."system_code" = 'insurance'
            )
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const filas: unknown = await queryRunner.query(
      `SELECT (SELECT count(*) FROM "insurer") + (SELECT count(*) FROM "insurance_policy") + (SELECT count(*) FROM "insurance_installment") AS filas`,
    );
    const { filas: total } = (filas as Array<{ filas: string }>)[0];
    if (Number(total) > 0) {
      throw new Error(
        `No se puede revertir: hay ${total} filas de aseguradoras, pólizas o cuotas`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE "insurance_policy" DROP CONSTRAINT "EXC_insurance_policy_solapada"`,
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_insurer_nombre_vigente"`);
    await queryRunner.query(
      `ALTER TABLE "insurance_policy" DROP CONSTRAINT "FK_insurance_policy_car_distribuidora"`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_policy" DROP CONSTRAINT "FK_insurance_policy_insurer_distribuidora"`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_policy" DROP CONSTRAINT "FK_ff1cbeb268c9cc622ac2c402d23"`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_policy" DROP CONSTRAINT "FK_a8291ef34a06769c7dd2d1a9499"`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_policy" DROP CONSTRAINT "FK_4f37c7f40a994811b13f0321402"`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" DROP CONSTRAINT "FK_insurance_installment_policy_distribuidora"`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" DROP CONSTRAINT "FK_insurance_installment_cash_movement_distribuidora"`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" DROP CONSTRAINT "FK_insurance_installment_cash_movement"`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" DROP CONSTRAINT "FK_eadf2703c66f95dad99f29b3bb4"`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" DROP CONSTRAINT "FK_852ffa13f211e5f23a17165ab0e"`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" DROP CONSTRAINT "FK_9993987124d04a4b1e4792e4380"`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurance_installment" DROP CONSTRAINT "FK_669ab39fd68649a5ddaccc9f318"`,
    );
    await queryRunner.query(
      `ALTER TABLE "insurer" DROP CONSTRAINT "FK_065c967be7908402287a8a75cc1"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_insurance_policy_numero_vigente"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_insurance_policy_car"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_insurance_policy_distributor"`,
    );
    await queryRunner.query(`DROP TABLE "insurance_policy"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_insurance_installment_numero"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_insurance_installment_vencimiento"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_insurance_installment_distributor"`,
    );
    await queryRunner.query(`DROP TABLE "insurance_installment"`);
    await queryRunner.query(
      `DROP TYPE "public"."insurance_installment_status_enum"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_insurer_distributor"`);
    await queryRunner.query(`DROP TABLE "insurer"`);
  }
}
