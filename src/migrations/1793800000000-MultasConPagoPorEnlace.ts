import { MigrationInterface, QueryRunner } from 'typeorm';

export class MultasConPagoPorEnlace1793800000000 implements MigrationInterface {
  name = 'MultasConPagoPorEnlace1793800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "traffic_fine" ADD "payment_url" character varying(500)`,
    );
    await queryRunner.query(
      `ALTER TABLE "traffic_fine" ADD "payment_code" character varying(80)`,
    );
    await queryRunner.query(
      `ALTER TABLE "traffic_fine" ADD "operation_number" character varying(60)`,
    );
    await queryRunner.query(
      `ALTER TABLE "traffic_fine" ADD "receipt_attachment_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "traffic_fine" ADD CONSTRAINT "CHK_traffic_fine_comprobante_de_pago" CHECK (("receipt_attachment_id" IS NULL AND "operation_number" IS NULL) OR ("status" = 'paid' AND "receipt_attachment_id" IS NOT NULL AND "cash_movement_id" IS NOT NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "traffic_fine" ADD CONSTRAINT "CHK_traffic_fine_enlace_de_pago" CHECK ("payment_url" IS NULL OR ("payment_url" ~ '^https://[^[:space:]]+$' AND char_length("payment_url") <= 500))`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" ADD CONSTRAINT "UQ_attachment_id_distribuidora" UNIQUE ("attachment_id", "distributor_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "traffic_fine" ADD CONSTRAINT "FK_traffic_fine_receipt_attachment" FOREIGN KEY ("receipt_attachment_id") REFERENCES "attachment"("attachment_id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "traffic_fine" ADD CONSTRAINT "FK_traffic_fine_receipt_attachment_distribuidora" FOREIGN KEY ("receipt_attachment_id", "distributor_id") REFERENCES "attachment"("attachment_id","distributor_id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "traffic_fine" DROP CONSTRAINT "FK_traffic_fine_receipt_attachment_distribuidora"`,
    );
    await queryRunner.query(
      `ALTER TABLE "traffic_fine" DROP CONSTRAINT "FK_traffic_fine_receipt_attachment"`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" DROP CONSTRAINT "UQ_attachment_id_distribuidora"`,
    );
    await queryRunner.query(
      `ALTER TABLE "traffic_fine" DROP CONSTRAINT "CHK_traffic_fine_enlace_de_pago"`,
    );
    await queryRunner.query(
      `ALTER TABLE "traffic_fine" DROP CONSTRAINT "CHK_traffic_fine_comprobante_de_pago"`,
    );
    await queryRunner.query(
      `ALTER TABLE "traffic_fine" DROP COLUMN "receipt_attachment_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "traffic_fine" DROP COLUMN "operation_number"`,
    );
    await queryRunner.query(
      `ALTER TABLE "traffic_fine" DROP COLUMN "payment_code"`,
    );
    await queryRunner.query(
      `ALTER TABLE "traffic_fine" DROP COLUMN "payment_url"`,
    );
  }
}
