import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Caja completa, etapa 4 (API v2): conciliación con Mercado Pago, primera
 * parte: los valores nuevos de los enums. Van aparte de las tablas porque un
 * valor de enum agregado no se puede usar en la misma transacción que lo agrega.
 *
 * - `cash_category.system_code`: «Impuestos y retenciones» (egreso) y
 *   «Reintegros de Mercado Pago» (ingreso).
 * - `cash_movement.reference_type`: `mp_reconciliation`, el ajuste asentado
 *   desde una conciliación.
 * - `attachment.owner_type`: `mp_reconciliation`, el reporte filtrado de la corrida.
 */
export class ConciliacionMpEnums1794200000000 implements MigrationInterface {
  name = 'ConciliacionMpEnums1794200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const sql = (texto: string) => queryRunner.query(texto);
    for (const codigo of ['taxes_withholdings', 'mercadopago_fee_refund']) {
      await sql(
        `ALTER TYPE "public"."cash_category_system_code_enum" ADD VALUE IF NOT EXISTS '${codigo}'`,
      );
    }
    await sql(
      `ALTER TYPE "public"."cash_movement_reference_type_enum" ADD VALUE IF NOT EXISTS 'mp_reconciliation'`,
    );
    await sql(
      `ALTER TYPE "public"."attachment_owner_type_enum" ADD VALUE IF NOT EXISTS 'mp_reconciliation'`,
    );
  }

  /**
   * Aborta antes de tocar nada si hay movimientos o adjuntos con los valores
   * nuevos: esa historia no se descarta sola. Los valores del enum quedan:
   * Postgres no permite quitarlos y son inocuos.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const usos: unknown = await queryRunner.query(
      `SELECT
         (SELECT count(*) FROM "cash_movement" WHERE "reference_type" = 'mp_reconciliation') AS movimientos,
         (SELECT count(*) FROM "attachment" WHERE "owner_type" = 'mp_reconciliation') AS adjuntos`,
    );
    const { movimientos, adjuntos } = (
      usos as Array<{ movimientos: string; adjuntos: string }>
    )[0];
    if (Number(movimientos) > 0 || Number(adjuntos) > 0) {
      throw new Error(
        `No se puede revertir: hay ${movimientos} movimientos de caja y ${adjuntos} adjuntos de conciliaciones con Mercado Pago`,
      );
    }
    await queryRunner.query(
      `DELETE FROM "cash_category" WHERE "system_code" IN ('taxes_withholdings', 'mercadopago_fee_refund')`,
    );
  }
}
