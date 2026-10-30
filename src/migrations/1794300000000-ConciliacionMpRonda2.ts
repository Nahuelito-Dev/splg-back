import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Caja completa, etapa 4, ronda 2.
 * - `mp_reconciliation_item.kind`: `tax_refund` (impuestos que Mercado Pago devolvió en una devolución).
 * - `UQ_mp_reconciliation_item_cuenta_aplicada`: una fila de la cuenta (retiro, impuesto suelto)
 *   se asienta una sola vez en todo el sistema, no una vez por distribuidora.
 */
export class ConciliacionMpRonda21794300000000 implements MigrationInterface {
  name = 'ConciliacionMpRonda21794300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."mp_reconciliation_item_kind_enum" ADD VALUE IF NOT EXISTS 'tax_refund'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_mp_reconciliation_item_cuenta_aplicada" ON "mp_reconciliation_item" ("row_key") WHERE "status" = 'applied' AND "account_level" = true`,
    );
  }

  /** Aborta si hay ajustes de impuestos devueltos; el valor del enum queda (Postgres no los quita). */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const filas: unknown = await queryRunner.query(
      `SELECT count(*) AS n FROM "mp_reconciliation_item" WHERE "kind" = 'tax_refund'`,
    );
    const { n } = (filas as Array<{ n: string }>)[0];
    if (Number(n) > 0) {
      throw new Error(
        `No se puede revertir: hay ${n} diferencias de impuestos devueltos`,
      );
    }
    await queryRunner.query(
      `DROP INDEX "public"."UQ_mp_reconciliation_item_cuenta_aplicada"`,
    );
  }
}
