import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F13: los documentos y la foto de la patente de un vehículo se guardan como
 * adjunto protegido (`car_document`) y la foto se lee con su propio tipo
 * (`foto_de_patente`). Sólo agrega valores a dos enums: sin columnas nuevas,
 * el mapa de auditoría no cambia.
 */
export class DocumentosDeVehiculo1795000000025 implements MigrationInterface {
  name = 'DocumentosDeVehiculo1795000000025';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."attachment_owner_type_enum" ADD VALUE IF NOT EXISTS 'car_document'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."document_reading_type_enum" ADD VALUE IF NOT EXISTS 'foto_de_patente'`,
    );
  }

  /** Aborta si algún adjunto o lectura usa los valores nuevos: esa historia no se descarta sola. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const filas: unknown = await queryRunner.query(
      `SELECT
         (SELECT count(*) FROM "attachment" WHERE "owner_type" = 'car_document') AS adjuntos,
         (SELECT count(*) FROM "document_reading"
           WHERE "expected_type" = 'foto_de_patente' OR "detected_type" = 'foto_de_patente') AS lecturas,
         (SELECT count(*) FROM "document_reading_example" WHERE "document_type" = 'foto_de_patente') AS ejemplos`,
    );
    const [usos] = filas as Array<{
      adjuntos: string;
      lecturas: string;
      ejemplos: string;
    }>;
    const total =
      Number(usos?.adjuntos ?? 0) +
      Number(usos?.lecturas ?? 0) +
      Number(usos?.ejemplos ?? 0);
    if (total > 0) {
      throw new Error(
        `No se puede revertir: hay ${usos.adjuntos} documentos de vehículos, ${usos.lecturas} lecturas y ${usos.ejemplos} correcciones de fotos de patente`,
      );
    }

    await queryRunner.query(
      `ALTER TYPE "public"."document_reading_type_enum" RENAME TO "document_reading_type_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."document_reading_type_enum" AS ENUM('comprobante_de_pago', 'factura_o_remito', 'poliza', 'revision_tecnica', 'cedula_del_vehiculo', 'licencia_de_conducir', 'apto_medico', 'otro')`,
    );
    for (const [tabla, columna] of [
      ['document_reading', 'expected_type'],
      ['document_reading', 'detected_type'],
      ['document_reading_example', 'document_type'],
    ]) {
      await queryRunner.query(
        `ALTER TABLE "${tabla}" ALTER COLUMN "${columna}" TYPE "public"."document_reading_type_enum" USING "${columna}"::text::"public"."document_reading_type_enum"`,
      );
    }
    await queryRunner.query(
      `DROP TYPE "public"."document_reading_type_enum_old"`,
    );

    await queryRunner.query(
      `ALTER TYPE "public"."attachment_owner_type_enum" RENAME TO "attachment_owner_type_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."attachment_owner_type_enum" AS ENUM('employee', 'fuel_load', 'traffic_fine', 'vehicle_accident', 'purchase_receipt', 'stock_adjustment', 'driver_settlement', 'cash_movement', 'customer_account_entry', 'order', 'insurance_policy', 'insurance_installment', 'traffic_fine_payment', 'mp_reconciliation')`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" ALTER COLUMN "owner_type" TYPE "public"."attachment_owner_type_enum" USING "owner_type"::text::"public"."attachment_owner_type_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."attachment_owner_type_enum_old"`,
    );
  }
}
