import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Caja completa, etapa 3, ronda 2: los orígenes nuevos del libro. Va aparte
 * porque un valor de enum agregado no se puede usar en la misma transacción.
 * - `payment_external_refund`: devolución o contracargo que hizo Mercado Pago.
 * - `order_deposit`: seña de una reserva en efectivo o por transferencia.
 */
export class IngresosDeVentasRonda2Enums1794100000000
  implements MigrationInterface
{
  name = 'IngresosDeVentasRonda2Enums1794100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const origen of ['payment_external_refund', 'order_deposit']) {
      await queryRunner.query(
        `ALTER TYPE "public"."cash_movement_reference_type_enum" ADD VALUE IF NOT EXISTS '${origen}'`,
      );
    }
  }

  /** Aborta si hay movimientos con los valores nuevos; los valores del enum quedan (Postgres no los quita). */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const usos: unknown = await queryRunner.query(
      `SELECT count(*) AS movimientos FROM "cash_movement" WHERE "reference_type" IN ('payment_external_refund', 'order_deposit')`,
    );
    const { movimientos } = (usos as Array<{ movimientos: string }>)[0];
    if (Number(movimientos) > 0) {
      throw new Error(
        `No se puede revertir: hay ${movimientos} movimientos de caja de devoluciones externas o señas`,
      );
    }
  }
}
