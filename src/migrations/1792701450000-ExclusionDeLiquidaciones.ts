import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Los períodos de las liquidaciones de un mismo chofer no se pisan (las anuladas
 * no cuentan): restricción de exclusión con `btree_gist`, el borde cuenta (los
 * días son cerrados: 1 al 7 y 7 al 14 se pisan). Antes se cuentan los pares que
 * hoy se pisarían; si hubiera alguno, la migración aborta con la lista en vez de
 * anular o recortar liquidaciones por su cuenta.
 */
export class ExclusionDeLiquidaciones1792701450000
  implements MigrationInterface
{
  name = 'ExclusionDeLiquidaciones1792701450000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const pares = (await queryRunner.query(`
      SELECT a.number AS a, b.number AS b, a.employee_id
        FROM driver_liquidation a
        JOIN driver_liquidation b ON b.employee_id = a.employee_id AND b.liquidation_id > a.liquidation_id
       WHERE a.status <> 'voided' AND b.status <> 'voided'
         AND a.period_from <= b.period_to AND b.period_from <= a.period_to
    `)) as Array<{ a: number; b: number; employee_id: string }>;
    if (pares.length > 0) {
      throw new Error(
        `No se puede crear la exclusión de períodos de liquidación: hay ${pares.length} par(es) que se pisan (N° ${pares
          .map((p) => `${p.a}/${p.b}`)
          .join(', ')}). Anulá una de cada par y reintentá.`,
      );
    }
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
    await queryRunner.query(
      `ALTER TABLE "driver_liquidation" ADD CONSTRAINT "EXC_driver_liquidation_periodo_solapado" EXCLUDE USING gist (
         "employee_id" WITH =,
         daterange("period_from", "period_to", '[]') WITH &&
       ) WHERE ("status" <> 'voided')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "driver_liquidation" DROP CONSTRAINT "EXC_driver_liquidation_periodo_solapado"`,
    );
  }
}
