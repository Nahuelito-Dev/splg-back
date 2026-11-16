import { MigrationInterface, QueryRunner } from 'typeorm';

export class AdjuntosGenericos1791062618698 implements MigrationInterface {
  name = 'AdjuntosGenericos1791062618698';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."attachment_owner_type_enum" AS ENUM('employee', 'fuel_load', 'traffic_fine', 'vehicle_accident', 'purchase_receipt', 'stock_adjustment', 'driver_settlement', 'cash_movement', 'customer_account_entry')`,
    );
    await queryRunner.query(
      `CREATE TABLE "attachment" ("attachment_id" uuid NOT NULL DEFAULT uuid_generate_v4(), "distributor_id" uuid NOT NULL, "owner_type" "public"."attachment_owner_type_enum" NOT NULL, "owner_id" uuid NOT NULL, "label" character varying(80), "storage_key" character varying(255) NOT NULL, "original_name" character varying(255) NOT NULL, "mime_type" character varying(100) NOT NULL, "size_bytes" integer NOT NULL, "uploaded_by_user_id" uuid NOT NULL, "uploaded_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_31d5367aee6b3ad16c69cce1cde" PRIMARY KEY ("attachment_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_70d35b9e83fa8fca69e685f548" ON "attachment" ("distributor_id", "owner_type", "owner_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" ADD CONSTRAINT "FK_2a226377b800631ab8142a2fe8c" FOREIGN KEY ("distributor_id") REFERENCES "distributor"("distributor_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" ADD CONSTRAINT "FK_0e9e069d0e8d22fab610a465c16" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "attachment" DROP CONSTRAINT "FK_0e9e069d0e8d22fab610a465c16"`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" DROP CONSTRAINT "FK_2a226377b800631ab8142a2fe8c"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_70d35b9e83fa8fca69e685f548"`,
    );
    await queryRunner.query(`DROP TABLE "attachment"`);
    await queryRunner.query(`DROP TYPE "public"."attachment_owner_type_enum"`);
  }
}
