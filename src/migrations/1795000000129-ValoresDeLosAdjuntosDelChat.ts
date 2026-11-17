import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CH7, primera parte: los valores nuevos de dos enums, en su propia migración
 * (un valor nuevo de un enum no se puede usar en la misma transacción que lo
 * agrega; la siguiente, `AdjuntosDelChat`, ya los usa).
 *
 * 1. `attachment_owner_type_enum` suma `chat_message` (el adjunto de un
 *    mensaje del chat).
 * 2. `process_run_process_enum` suma `chat_attachment_scan` (la tarea que
 *    retoma los escaneos que quedaron pendientes).
 */
export class ValoresDeLosAdjuntosDelChat1795000000129
  implements MigrationInterface
{
  name = 'ValoresDeLosAdjuntosDelChat1795000000129';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."attachment_owner_type_enum" ADD VALUE IF NOT EXISTS 'chat_message'`,
    );
    await queryRunner.query(
      `ALTER TYPE "process_run_process_enum" ADD VALUE IF NOT EXISTS 'chat_attachment_scan'`,
    );
  }

  /**
   * Aborta si hay adjuntos del chat: esa historia no se descarta sola. El
   * valor del enum de procesos queda (Postgres no quita valores de un enum y
   * sus corridas son historia).
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const filas: unknown = await queryRunner.query(
      `SELECT count(*) AS n FROM "attachment" WHERE "owner_type"::text = 'chat_message'`,
    );
    const [uso] = filas as Array<{ n: string }>;
    if (Number(uso?.n ?? 0) > 0) {
      throw new Error(
        `No se puede revertir: hay ${uso.n} adjuntos de mensajes del chat`,
      );
    }
    await queryRunner.query(
      `ALTER TYPE "public"."attachment_owner_type_enum" RENAME TO "attachment_owner_type_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."attachment_owner_type_enum" AS ENUM('employee', 'fuel_load', 'traffic_fine', 'vehicle_accident', 'purchase_receipt', 'stock_adjustment', 'driver_settlement', 'cash_movement', 'customer_account_entry', 'order', 'insurance_policy', 'insurance_installment', 'traffic_fine_payment', 'mp_reconciliation', 'car_document')`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachment" ALTER COLUMN "owner_type" TYPE "public"."attachment_owner_type_enum" USING "owner_type"::text::"public"."attachment_owner_type_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."attachment_owner_type_enum_old"`,
    );
  }
}
