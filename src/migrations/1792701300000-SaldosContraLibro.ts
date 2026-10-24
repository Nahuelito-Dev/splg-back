import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  sentenciasDeSaldos,
  sentenciasParaQuitarSaldos,
} from './sql/saldo-contra-libro';

/**
 * Saldo contra libro (tanda V2 de validaciones): el saldo de cada caja, de cada
 * cuenta corriente y de cada renglón de existencia tiene que ser la suma de sus
 * movimientos, verificado al commit con constraint triggers diferidos (ver
 * `sql/saldo-contra-libro.ts`). Además, lo imputado a un asiento de cuenta
 * corriente no puede superar su importe.
 *
 * Antes de crearlos se verifica que hoy cierran: si alguna caja, cuenta o
 * existencia no coincide con su libro, la migración aborta con el diagnóstico en
 * vez de dejar una base que no puede escribir. El índice de destino/origen de
 * los movimientos de stock pasa a ser compuesto (ubicación, garrafa, condición):
 * es el que usa la suma del control.
 */
export class SaldosContraLibro1792701300000 implements MigrationInterface {
  name = 'SaldosContraLibro1792701300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const descuadres = (await queryRunner.query(`
      SELECT 'caja' AS tipo, count(*)::int AS filas FROM (
        SELECT b.cash_box_id FROM cash_box b
          LEFT JOIN cash_movement m ON m.cash_box_id = b.cash_box_id
         GROUP BY b.cash_box_id, b.balance
        HAVING b.balance <> coalesce(sum(CASE m.direction WHEN 'in' THEN m.amount ELSE -m.amount END), 0)) x
      UNION ALL
      SELECT 'cuenta corriente', count(*)::int FROM (
        SELECT a.account_id FROM customer_account a
          LEFT JOIN customer_account_entry e ON e.account_id = a.account_id
         GROUP BY a.account_id, a.balance
        HAVING a.balance <> coalesce(sum(CASE WHEN e.type IN ('sale_charge', 'debit_note') THEN e.amount ELSE -e.amount END), 0)) y
      UNION ALL
      SELECT 'existencia', count(*)::int FROM (
        WITH libro AS (
          SELECT to_location_id AS ubicacion, gas_cylinder_id AS garrafa, to_condition AS condicion, quantity AS cantidad
            FROM stock_movement WHERE to_location_id IS NOT NULL
          UNION ALL
          SELECT from_location_id, gas_cylinder_id, from_condition, -quantity
            FROM stock_movement WHERE from_location_id IS NOT NULL),
        suma AS (SELECT ubicacion, garrafa, condicion, sum(cantidad) AS cantidad FROM libro GROUP BY 1, 2, 3)
        SELECT 1 FROM stock_balance b
          FULL JOIN suma s ON s.ubicacion = b.location_id AND s.garrafa = b.gas_cylinder_id AND s.condicion = b.condition
         WHERE coalesce(b.quantity, 0) <> coalesce(s.cantidad, 0)) z
    `)) as Array<{ tipo: string; filas: number }>;
    const rotos = descuadres.filter((d) => d.filas > 0);
    if (rotos.length > 0) {
      throw new Error(
        `No se puede crear el control de saldos contra el libro: ${rotos
          .map((d) => `${d.filas} ${d.tipo}`)
          .join(
            ', ',
          )} no coinciden con la suma de sus movimientos. Corregilos (ajustando el saldo con un movimiento, no a mano) y reintentá.`,
      );
    }

    await queryRunner.query(`DROP INDEX "IDX_stock_movement_destino"`);
    await queryRunner.query(`DROP INDEX "IDX_stock_movement_origen"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_stock_movement_destino" ON "stock_movement" ("to_location_id", "gas_cylinder_id", "to_condition")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_stock_movement_origen" ON "stock_movement" ("from_location_id", "gas_cylinder_id", "from_condition")`,
    );

    for (const sql of sentenciasDeSaldos()) {
      await queryRunner.query(sql);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of sentenciasParaQuitarSaldos()) {
      await queryRunner.query(sql);
    }
    await queryRunner.query(`DROP INDEX "IDX_stock_movement_destino"`);
    await queryRunner.query(`DROP INDEX "IDX_stock_movement_origen"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_stock_movement_destino" ON "stock_movement" ("to_location_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_stock_movement_origen" ON "stock_movement" ("from_location_id")`,
    );
  }
}
