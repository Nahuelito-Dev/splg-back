import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Caja completa, etapa 3 (API v2): lo que se cobra por las ventas entra a una
 * caja, primera parte: los valores nuevos de los enums. Va aparte de la tabla
 * porque un valor de enum agregado no se puede usar en la misma transacción que
 * lo agrega (las categorías se siembran en `IngresosDeVentas`).
 *
 * - `cash_category.system_code`: «Comisiones de Mercado Pago» y «Devoluciones a
 *   clientes» (egresos).
 * - `cash_movement.reference_type`: de qué cobro nace el movimiento.
 */
export class IngresosDeVentasEnumsDeCaja1794000000000
  implements MigrationInterface
{
  name = 'IngresosDeVentasEnumsDeCaja1794000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const codigo of ['mercadopago_fee', 'customer_refund']) {
      await queryRunner.query(
        `ALTER TYPE "public"."cash_category_system_code_enum" ADD VALUE IF NOT EXISTS '${codigo}'`,
      );
    }
    for (const origen of [
      'payment',
      'payment_fee',
      'payment_refund',
      'order_transfer',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "public"."cash_movement_reference_type_enum" ADD VALUE IF NOT EXISTS '${origen}'`,
      );
    }
  }

  /**
   * Aborta antes de tocar nada si hay movimientos con los valores nuevos: esa
   * historia no se descarta sola. Las categorías sin movimientos se quitan,
   * como las demás categorías de sistema. Los valores del enum quedan: Postgres
   * no permite quitarlos y son inocuos.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const usos: unknown = await queryRunner.query(
      `SELECT count(*) AS movimientos FROM "cash_movement"
       WHERE "reference_type" IN ('payment', 'payment_fee', 'payment_refund', 'order_transfer')`,
    );
    const { movimientos } = (usos as Array<{ movimientos: string }>)[0];
    if (Number(movimientos) > 0) {
      throw new Error(
        `No se puede revertir: hay ${movimientos} movimientos de caja de cobros de ventas`,
      );
    }
    await queryRunner.query(
      `DELETE FROM "cash_category" WHERE "system_code" IN ('mercadopago_fee', 'customer_refund')`,
    );
  }
}
